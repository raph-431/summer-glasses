// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC721} from "openzeppelin-contracts/token/ERC721/ERC721.sol";
import {Ownable} from "openzeppelin-contracts/access/Ownable.sol";
import {Base64} from "openzeppelin-contracts/utils/Base64.sol";
import {Strings} from "openzeppelin-contracts/utils/Strings.sol";

/// @title Gift Receipt — a keepsake for the gifter.
///
/// When someone prepays a Summer Glasses gift, `gift()` also mints them one of
/// these: a small on-chain card noting the date and a thank-you. It exists for
/// two reasons.
///
///  1. UX / provenance — the gifter walks away with an on-chain artifact of the
///     gift they gave, not just a code on a piece of paper.
///  2. Wallet safety heuristics — a bare `gift()` moves ETH out and returns no
///     asset, the shape of a drainer; wallet simulators (MetaMask/Blockaid)
///     flag it. Minting the payer a token makes the simulation show an asset
///     received, which is the honest picture: they did get something.
///
/// The receipt says NOTHING about the claim key, recipient, or amount — it is a
/// memento, never a way to redeem. Minting is restricted to the Summer Glasses
/// contract, set once and then immutable.
contract GiftReceipt is ERC721, Ownable {
    using Strings for uint256;

    /// the SummerGlasses contract; the only address allowed to mint. Set once.
    address public minter;

    uint256 public nextId = 1;
    mapping(uint256 => uint256) public giftedAt; // unix timestamp of the gift

    string private constant NOTE_1 = "A glass of something cold";
    string private constant NOTE_2 = "is waiting to be poured.";

    constructor() ERC721(unicode"Summer Glasses — Gift Receipt", "GIFT") Ownable(msg.sender) {}

    /// Bind the minter (the SummerGlasses contract) exactly once. After this,
    /// nobody — not even the owner — can change who mints receipts.
    function setMinter(address m) external onlyOwner {
        require(minter == address(0), "minter set");
        require(m != address(0), "zero minter");
        minter = m;
    }

    /// Mint a receipt to `to`. Only the bound minter may call. Uses `_mint`
    /// (not `_safeMint`) on purpose: the receiver is the gift's payer, and a
    /// receiver callback must never be able to make `gift()` revert.
    function mint(address to) external returns (uint256 id) {
        require(msg.sender == minter, "only minter");
        id = nextId++;
        giftedAt[id] = block.timestamp;
        _mint(to, id);
    }

    // ---- metadata --------------------------------------------------------

    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        _requireOwned(tokenId);
        string memory when = _formatUTC(giftedAt[tokenId]);
        string memory num = tokenId.toString();

        bytes memory svg = _card(num, when);
        bytes memory json = abi.encodePacked(
            '{"name":"Gift Receipt #', num,
            '","description":"A keepsake for a Summer Glasses gift, gifted ', when,
            '. Fully on-chain. It carries no code and cannot redeem anything - the gift itself travels separately.',
            '","image":"data:image/svg+xml;base64,', Base64.encode(svg), '"}'
        );
        return string(abi.encodePacked("data:application/json;base64,", Base64.encode(json)));
    }

    /// The on-chain SVG: a warm, sunlit card. No external fonts or assets.
    /// Split into two encodePacked calls to keep the stack shallow.
    function _card(string memory num, string memory when) internal pure returns (bytes memory) {
        bytes memory head = abi.encodePacked(
            "<svg xmlns='http://www.w3.org/2000/svg' width='600' height='380' viewBox='0 0 600 380'>",
            "<defs>",
            "<linearGradient id='sky' x1='0' y1='0' x2='0' y2='1'>",
            "<stop offset='0' stop-color='#ffeccb'/><stop offset='0.55' stop-color='#ffd49c'/>",
            "<stop offset='1' stop-color='#f4b26a'/></linearGradient>",
            "<radialGradient id='sun' cx='0.82' cy='0.16' r='0.55'>",
            "<stop offset='0' stop-color='#fff8e6' stop-opacity='0.95'/>",
            "<stop offset='1' stop-color='#fff8e6' stop-opacity='0'/></radialGradient>",
            "</defs>",
            "<rect width='600' height='380' fill='url(#sky)'/>",
            "<rect width='600' height='380' fill='url(#sun)'/>",
            "<rect x='18' y='18' width='564' height='344' rx='6' fill='none' stroke='#8a5a2b' stroke-opacity='0.35' stroke-width='1.5'/>",
            "<text x='300' y='84' text-anchor='middle' font-family='Helvetica,Arial,sans-serif' font-size='27' letter-spacing='9' fill='#7a4a1e'>SUMMER GLASSES</text>"
        );
        bytes memory body = abi.encodePacked(
            "<text x='300' y='114' text-anchor='middle' font-family='Helvetica,Arial,sans-serif' font-size='13' letter-spacing='4' fill='#7a4a1e' fill-opacity='0.7'>GIFT RECEIPT &#183; No. ", num, "</text>",
            "<line x1='210' y1='142' x2='390' y2='142' stroke='#8a5a2b' stroke-opacity='0.4' stroke-width='1'/>",
            "<text x='300' y='210' text-anchor='middle' font-family='Georgia,serif' font-style='italic' font-size='27' fill='#6b4423'>", NOTE_1, "</text>",
            "<text x='300' y='246' text-anchor='middle' font-family='Georgia,serif' font-style='italic' font-size='27' fill='#6b4423'>", NOTE_2, "</text>"
        );
        bytes memory foot = abi.encodePacked(
            "<text x='300' y='312' text-anchor='middle' font-family='Helvetica,Arial,sans-serif' font-size='15' letter-spacing='1' fill='#7a4a1e'>Gifted ", when, "</text>",
            "<text x='300' y='340' text-anchor='middle' font-family='Georgia,serif' font-style='italic' font-size='14' fill='#7a4a1e' fill-opacity='0.75'>with thanks</text>",
            "</svg>"
        );
        return abi.encodePacked(head, body, foot);
    }

    // ---- date -------------------------------------------------------------

    /// Format a unix timestamp as e.g. "23 July 2026, 14:32 UTC". Comma
    /// separator so it reads cleanly both in the SVG and in the plain-text
    /// JSON description (an HTML entity would show raw in the latter).
    function _formatUTC(uint256 ts) internal pure returns (string memory) {
        uint256 daysSinceEpoch = ts / 86400;
        uint256 secOfDay = ts % 86400;
        uint256 hh = secOfDay / 3600;
        uint256 mm = (secOfDay % 3600) / 60;
        (uint256 y, uint256 m, uint256 d) = _civilFromDays(daysSinceEpoch);
        return string(abi.encodePacked(
            d.toString(), " ", _month(m), " ", y.toString(),
            ", ", _two(hh), ":", _two(mm), " UTC"
        ));
    }

    /// Civil date from days since 1970-01-01 (Howard Hinnant's algorithm).
    function _civilFromDays(uint256 z) internal pure returns (uint256 y, uint256 m, uint256 d) {
        z += 719468;
        uint256 era = z / 146097;
        uint256 doe = z - era * 146097;                                  // [0, 146096]
        uint256 yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365; // [0, 399]
        y = yoe + era * 400;
        uint256 doy = doe - (365 * yoe + yoe / 4 - yoe / 100);           // [0, 365]
        uint256 mp = (5 * doy + 2) / 153;                                // [0, 11]
        d = doy - (153 * mp + 2) / 5 + 1;                                // [1, 31]
        m = mp < 10 ? mp + 3 : mp - 9;                                   // [1, 12]
        if (m <= 2) y += 1;
    }

    function _month(uint256 m) internal pure returns (string memory) {
        string[12] memory names = [
            "January", "February", "March", "April", "May", "June",
            "July", "August", "September", "October", "November", "December"
        ];
        return names[m - 1];
    }

    function _two(uint256 n) internal pure returns (string memory) {
        return n < 10 ? string(abi.encodePacked("0", n.toString())) : n.toString();
    }
}
