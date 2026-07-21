// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC721} from "openzeppelin-contracts/token/ERC721/ERC721.sol";
import {ERC2981} from "openzeppelin-contracts/token/common/ERC2981.sol";
import {Ownable} from "openzeppelin-contracts/access/Ownable.sol";
import {ECDSA} from "openzeppelin-contracts/utils/cryptography/ECDSA.sol";
import {Base64} from "openzeppelin-contracts/utils/Base64.sol";
import {Strings} from "openzeppelin-contracts/utils/Strings.sol";
import {SSTORE2} from "./SSTORE2.sol";

/// @title Summer Glasses — an on-chain generative series, minted by gift.
///
/// One glass of something cold on a sunlit table, dealt from a hash. The
/// artwork (WebGL2, zero dependencies) lives in this contract's storage;
/// tokenURI reassembles it with the token's seed baked in.
///
/// The gifting flow ("lazy minting" with redeem codes):
///  - a GIFTER prepays `gift(claimAddr)`, where claimAddr is the address of
///    an ephemeral "claim key" generated in their browser. The private key —
///    rendered as a code / QR — is the gift; it never touches a server.
///  - the RECIPIENT redeems by presenting a signature by the claim key over
///    their own address. The signature binds the destination, so the redeem
///    transaction cannot be front-run, and — because authorization lives in
///    the signature, not msg.sender — anyone may submit it: a relayer
///    submits on the recipient's behalf and is reimbursed the gas stipend
///    the gifter prepaid. The recipient never needs ETH.
///  - the token's seed is fixed only at redemption (prevrandao + tokenId +
///    recipient): neither party knows which glass it is until it's poured.
///  - a gift never redeemed can be reclaimed by its gifter after a short
///    window, so lost codes don't strand funds for long.
contract SummerGlasses is ERC721, ERC2981, Ownable {
    using Strings for uint256;

    // ---- gifting ---------------------------------------------------------

    struct Gift {
        address payer;     // who prepaid (refund target for reclaim)
        uint96 paid;       // full amount escrowed (price + stipend + any tip)
        uint40 createdAt;  // reclaim clock starts here
        uint96 stipend;    // snapshot of gasStipend, paid to the redeem relayer
    }

    /// claim address (of the ephemeral gift key) => escrowed gift
    mapping(address => Gift) public gifts;
    uint256 public outstandingGifts; // prepaid but not yet redeemed/reclaimed

    /// per-payer count of outstanding (unredeemed, unreclaimed) gifts, and an
    /// owner-set ceiling on it. The cap blunts supply-squatting: without it a
    /// single address can reserve the whole supply (locking real buyers out)
    /// and reclaim every wei later. 0 = unlimited (the default). A determined
    /// Sybil can still spread gifts across addresses, so this raises the cost
    /// of casual griefing rather than eliminating it.
    mapping(address => uint256) public outstandingByPayer;
    uint256 public maxGiftsPerPayer;

    uint256 public price;
    uint96 public gasStipend;
    uint256 public maxSupply;
    bool public supplyLocked;

    uint256 public constant RECLAIM_AFTER = 7 days;

    /// proceeds of redeemed gifts, withdrawable by the owner. Funds of
    /// outstanding gifts are escrow — never touchable by anyone but their
    /// redeemer (stipend + proceeds) or, after expiry, their gifter.
    uint256 public withdrawable;

    // ---- tokens ----------------------------------------------------------

    uint256 public nextId = 1;
    mapping(uint256 => bytes32) public seedOf; // fixed forever at redemption

    // ---- artwork storage -------------------------------------------------

    // tokenURI html = artPrefix1 ++ seed-hex ++ artPrefix2 ++ chunks ++ artSuffix
    // (chunks hold the base64 of the gzipped single-file artwork; the
    // bootstrap in the prefixes inflates it in the browser)
    bytes public artPrefix1;
    bytes public artPrefix2;
    bytes public artSuffix;
    address[] public artChunks;
    bool public artFrozen;

    /// optional marketplace thumbnail: if set, tokenURI adds
    /// "image": imageBase + tokenId (e.g. "https://render.…/glass/").
    /// Deliberately NOT under artFrozen — the canonical artwork is the
    /// frozen animation_url; this is a mutable convenience pointer that can
    /// be added or improved after launch.
    string public imageBase;

    string public constant DESCRIPTION =
        "A glass of something cold on a sunlit table, dealt from this token's "
        "seed: photon-traced caustics, a raymarched glass, cicadas. Fully "
        "on-chain, WebGL2. One deal per glass, fixed at redemption.";

    // ---- events ----------------------------------------------------------

    event Gifted(address indexed claimAddr, address indexed payer, uint256 paid);
    event Redeemed(address indexed claimAddr, uint256 indexed tokenId, address indexed to, bytes32 seed);
    event Reclaimed(address indexed claimAddr, address indexed payer, uint256 refunded);
    event ArtFrozen();

    constructor(uint256 price_, uint96 gasStipend_, uint256 maxSupply_)
        ERC721("Summer Glasses", "GLASS")
        Ownable(msg.sender)
    {
        price = price_;
        gasStipend = gasStipend_;
        maxSupply = maxSupply_;
    }

    // ---- the gift flow ---------------------------------------------------

    /// Prepay a gift slot for a claim key. Everything sent is escrowed and
    /// reclaimable by the payer after RECLAIM_AFTER if never redeemed.
    function gift(address claimAddr) external payable {
        require(claimAddr != address(0), "zero claim address");
        require(gifts[claimAddr].payer == address(0), "slot taken");
        require(msg.value >= price + gasStipend, "underpaid");
        require(msg.value <= type(uint96).max, "overpaid");
        require(nextId - 1 + outstandingGifts < maxSupply, "sold out");
        require(
            maxGiftsPerPayer == 0 || outstandingByPayer[msg.sender] < maxGiftsPerPayer,
            "payer gift limit"
        );

        gifts[claimAddr] = Gift({
            payer: msg.sender,
            paid: uint96(msg.value),
            createdAt: uint40(block.timestamp),
            stipend: gasStipend
        });
        outstandingGifts += 1;
        outstandingByPayer[msg.sender] += 1;
        emit Gifted(claimAddr, msg.sender, msg.value);
    }

    /// What the claim key must sign (raw digest, no EIP-191 prefix): chain
    /// and contract scope the signature; `to` binds the recipient so the
    /// transaction is useless to a mempool observer.
    function redeemDigest(address to) public view returns (bytes32) {
        return keccak256(abi.encodePacked(block.chainid, address(this), to));
    }

    /// Redeem a gift: mint to `to`, authorized by the claim key's signature.
    /// Callable by anyone (relayer pattern); msg.sender receives the stipend.
    function redeem(address claimAddr, address to, bytes calldata sig) external returns (uint256 tokenId) {
        Gift memory g = gifts[claimAddr];
        require(g.payer != address(0), "unknown gift");
        require(ECDSA.recover(redeemDigest(to), sig) == claimAddr, "bad signature");

        delete gifts[claimAddr];
        outstandingGifts -= 1;
        outstandingByPayer[g.payer] -= 1;
        withdrawable += g.paid - g.stipend;

        tokenId = nextId++;
        bytes32 seed = keccak256(abi.encodePacked(tokenId, block.prevrandao, to));
        seedOf[tokenId] = seed;
        _mint(to, tokenId);
        emit Redeemed(claimAddr, tokenId, to, seed);

        (bool ok,) = msg.sender.call{value: g.stipend}("");
        require(ok, "stipend payout failed");
    }

    /// Refund a gift whose code was lost or never used.
    function reclaim(address claimAddr) external {
        Gift memory g = gifts[claimAddr];
        require(g.payer == msg.sender, "not the payer");
        require(block.timestamp >= uint256(g.createdAt) + RECLAIM_AFTER, "not expired");

        delete gifts[claimAddr];
        outstandingGifts -= 1;
        outstandingByPayer[g.payer] -= 1;
        emit Reclaimed(claimAddr, msg.sender, g.paid);

        (bool ok,) = msg.sender.call{value: g.paid}("");
        require(ok, "refund failed");
    }

    // ---- artwork ---------------------------------------------------------

    function setArtWrapper(bytes calldata prefix1, bytes calldata prefix2, bytes calldata suffix) external onlyOwner {
        require(!artFrozen, "art frozen");
        artPrefix1 = prefix1;
        artPrefix2 = prefix2;
        artSuffix = suffix;
    }

    function addArtChunk(bytes calldata data) external onlyOwner {
        require(!artFrozen, "art frozen");
        artChunks.push(SSTORE2.write(data));
    }

    function clearArtChunks() external onlyOwner {
        require(!artFrozen, "art frozen");
        delete artChunks;
    }

    function freezeArt() external onlyOwner {
        artFrozen = true;
        emit ArtFrozen();
    }

    function setImageBase(string calldata base) external onlyOwner {
        imageBase = base;
    }

    function artChunkCount() external view returns (uint256) {
        return artChunks.length;
    }

    /// The full bootstrap HTML for a given seed — what animation_url decodes to.
    function tokenHTML(bytes32 seed) public view returns (bytes memory html) {
        html = abi.encodePacked(artPrefix1, bytes(uint256(seed).toHexString(32)), artPrefix2);
        for (uint256 i = 0; i < artChunks.length; i++) {
            html = abi.encodePacked(html, SSTORE2.read(artChunks[i]));
        }
        html = abi.encodePacked(html, artSuffix);
    }

    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        _requireOwned(tokenId);
        bytes memory img = bytes(imageBase).length == 0
            ? bytes("")
            : abi.encodePacked(',"image":"', imageBase, tokenId.toString(), '"');
        bytes memory json = abi.encodePacked(
            '{"name":"Summer Glass #', tokenId.toString(),
            '","description":"', DESCRIPTION, '"', img,
            ',"animation_url":"data:text/html;base64,',
            Base64.encode(tokenHTML(seedOf[tokenId])),
            '"}'
        );
        return string(abi.encodePacked("data:application/json;base64,", Base64.encode(json)));
    }

    // ---- admin -----------------------------------------------------------

    function setPrice(uint256 price_) external onlyOwner {
        price = price_;
    }

    function setGasStipend(uint96 gasStipend_) external onlyOwner {
        gasStipend = gasStipend_;
    }

    function setMaxSupply(uint256 maxSupply_) external onlyOwner {
        require(!supplyLocked, "supply locked");
        require(maxSupply_ >= nextId - 1 + outstandingGifts, "below committed");
        maxSupply = maxSupply_;
    }

    function lockSupply() external onlyOwner {
        supplyLocked = true;
    }

    /// Cap on how many outstanding gifts one payer may hold at once (0 =
    /// unlimited). Set this at launch to blunt single-address supply-squatting;
    /// it only bounds gifts that are still unredeemed, so honest gifters are
    /// unaffected as their gifts get redeemed.
    function setMaxGiftsPerPayer(uint256 cap) external onlyOwner {
        maxGiftsPerPayer = cap;
    }

    /// ERC-2981 marketplace royalty. Unset by default; policy is a launch
    /// decision — the mechanism has to ship with the contract.
    function setRoyalty(address receiver, uint96 bps) external onlyOwner {
        _setDefaultRoyalty(receiver, bps);
    }

    function supportsInterface(bytes4 id) public view override(ERC721, ERC2981) returns (bool) {
        return super.supportsInterface(id);
    }

    function withdraw() external onlyOwner {
        uint256 amount = withdrawable;
        withdrawable = 0;
        (bool ok,) = owner().call{value: amount}("");
        require(ok, "withdraw failed");
    }
}
