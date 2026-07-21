// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {SummerGlasses} from "../src/SummerGlasses.sol";
import {Base64} from "openzeppelin-contracts/utils/Base64.sol";
import {Strings} from "openzeppelin-contracts/utils/Strings.sol";

contract SummerGlassesTest is Test {
    SummerGlasses glasses;

    uint256 constant PRICE = 0.01 ether;
    uint96 constant STIPEND = 0.001 ether;
    uint256 constant SUPPLY = 4;

    address owner = makeAddr("owner");
    address gifter = makeAddr("gifter");
    address relayer = makeAddr("relayer");
    address recipient = makeAddr("recipient");

    uint256 claimKey;
    address claimAddr;

    // direct redeem() calls land the stipend here
    receive() external payable {}

    function setUp() public {
        vm.prank(owner);
        glasses = new SummerGlasses(PRICE, STIPEND, SUPPLY);
        (claimAddr, claimKey) = makeAddrAndKey("claim-key");
        vm.deal(gifter, 10 ether);
    }

    // the recipient-side act: sign the redeem digest with the gift's claim key
    function claimSig(uint256 key, address to) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, glasses.redeemDigest(to));
        return abi.encodePacked(r, s, v);
    }

    function doGift() internal {
        vm.prank(gifter);
        glasses.gift{value: PRICE + STIPEND}(claimAddr);
    }

    // ---- gift ------------------------------------------------------------

    function test_GiftEscrowsAndCounts() public {
        doGift();
        (address payer, uint96 paid,, uint96 stipend) = glasses.gifts(claimAddr);
        assertEq(payer, gifter);
        assertEq(paid, PRICE + STIPEND);
        assertEq(stipend, STIPEND);
        assertEq(glasses.outstandingGifts(), 1);
        assertEq(address(glasses).balance, PRICE + STIPEND);
        assertEq(glasses.withdrawable(), 0); // escrow, not proceeds
    }

    function test_GiftUnderpaidReverts() public {
        vm.prank(gifter);
        vm.expectRevert("underpaid");
        glasses.gift{value: PRICE}(claimAddr);
    }

    function test_GiftSlotTakenReverts() public {
        doGift();
        vm.prank(gifter);
        vm.expectRevert("slot taken");
        glasses.gift{value: PRICE + STIPEND}(claimAddr);
    }

    function test_GiftZeroClaimAddrReverts() public {
        vm.prank(gifter);
        vm.expectRevert("zero claim address");
        glasses.gift{value: PRICE + STIPEND}(address(0));
    }

    // ---- redeem ----------------------------------------------------------

    function test_GiftRedeemHappyPath() public {
        doGift();
        bytes memory sig = claimSig(claimKey, recipient); // before prank: claimSig itself calls the contract
        vm.prank(relayer);
        uint256 id = glasses.redeem(claimAddr, recipient, sig);

        assertEq(id, 1);
        assertEq(glasses.ownerOf(1), recipient);
        assertTrue(glasses.seedOf(1) != bytes32(0));
        assertEq(glasses.outstandingGifts(), 0);
        assertEq(relayer.balance, STIPEND);           // relayer reimbursed
        assertEq(glasses.withdrawable(), PRICE);      // proceeds released from escrow
        (address payer,,,) = glasses.gifts(claimAddr);
        assertEq(payer, address(0));                  // slot cleared
    }

    /// The front-run scenario: an attacker sees the redeem tx in the mempool
    /// and resubmits with their own address. The signature binds `to`.
    function test_RedeemStolenToAttackerReverts() public {
        doGift();
        bytes memory sig = claimSig(claimKey, recipient);
        address attacker = makeAddr("attacker");
        vm.prank(attacker);
        vm.expectRevert("bad signature");
        glasses.redeem(claimAddr, attacker, sig);
    }

    function test_RedeemReplayReverts() public {
        doGift();
        bytes memory sig = claimSig(claimKey, recipient);
        vm.prank(relayer);
        glasses.redeem(claimAddr, recipient, sig);
        vm.prank(relayer);
        vm.expectRevert("unknown gift");
        glasses.redeem(claimAddr, recipient, sig);
    }

    function test_RedeemUnknownGiftReverts() public {
        bytes memory sig = claimSig(claimKey, recipient);
        vm.expectRevert("unknown gift");
        glasses.redeem(claimAddr, recipient, sig);
    }

    function test_RedeemWrongKeyReverts() public {
        doGift();
        (, uint256 wrongKey) = makeAddrAndKey("wrong-key");
        bytes memory sig = claimSig(wrongKey, recipient);
        vm.expectRevert("bad signature");
        glasses.redeem(claimAddr, recipient, sig);
    }

    function test_SeedsDifferPerToken() public {
        doGift();
        (address claim2, uint256 key2) = makeAddrAndKey("claim-key-2");
        vm.prank(gifter);
        glasses.gift{value: PRICE + STIPEND}(claim2);

        glasses.redeem(claimAddr, recipient, claimSig(claimKey, recipient));
        glasses.redeem(claim2, recipient, claimSig(key2, recipient));
        assertTrue(glasses.seedOf(1) != glasses.seedOf(2));
    }

    // ---- reclaim ---------------------------------------------------------

    function test_ReclaimBeforeExpiryReverts() public {
        doGift();
        vm.warp(block.timestamp + glasses.RECLAIM_AFTER() - 1);
        vm.prank(gifter);
        vm.expectRevert("not expired");
        glasses.reclaim(claimAddr);
    }

    function test_ReclaimAfterExpiryRefunds() public {
        doGift();
        uint256 before = gifter.balance;
        vm.warp(block.timestamp + glasses.RECLAIM_AFTER());
        vm.prank(gifter);
        glasses.reclaim(claimAddr);
        assertEq(gifter.balance, before + PRICE + STIPEND); // full refund incl. stipend
        assertEq(glasses.outstandingGifts(), 0);
        assertEq(address(glasses).balance, 0);
    }

    function test_ReclaimNotPayerReverts() public {
        doGift();
        vm.warp(block.timestamp + glasses.RECLAIM_AFTER());
        vm.prank(recipient);
        vm.expectRevert("not the payer");
        glasses.reclaim(claimAddr);
    }

    function test_ReclaimedSlotRedeemReverts() public {
        doGift();
        vm.warp(block.timestamp + glasses.RECLAIM_AFTER());
        vm.prank(gifter);
        glasses.reclaim(claimAddr);
        bytes memory sig = claimSig(claimKey, recipient);
        vm.expectRevert("unknown gift");
        glasses.redeem(claimAddr, recipient, sig);
    }

    function test_ReclaimWindowIsOneWeek() public view {
        assertEq(glasses.RECLAIM_AFTER(), 7 days);
    }

    // ---- supply ----------------------------------------------------------

    function test_SupplyCountsOutstandingGifts() public {
        for (uint256 i = 0; i < SUPPLY; i++) {
            vm.prank(gifter);
            glasses.gift{value: PRICE + STIPEND}(vm.addr(100 + i));
        }
        vm.prank(gifter);
        vm.expectRevert("sold out");
        glasses.gift{value: PRICE + STIPEND}(vm.addr(999));
    }

    function test_SupplyStillFullAfterRedeems() public {
        // redeeming converts outstanding -> minted; the sum stays at cap
        test_SupplyCountsOutstandingGifts();
        // claim keys 100..103 were used as raw private keys above
        (address c, uint256 k) = (vm.addr(100), 100);
        bytes memory sig = claimSig(k, recipient);
        vm.prank(relayer);
        glasses.redeem(c, recipient, sig);
        vm.prank(gifter);
        vm.expectRevert("sold out");
        glasses.gift{value: PRICE + STIPEND}(vm.addr(999));
    }

    function test_ReclaimFreesSupply() public {
        test_SupplyCountsOutstandingGifts();
        vm.warp(block.timestamp + glasses.RECLAIM_AFTER());
        vm.prank(gifter);
        glasses.reclaim(vm.addr(100));
        vm.prank(gifter);
        glasses.gift{value: PRICE + STIPEND}(vm.addr(999)); // now fits again
    }

    function test_SetMaxSupplyBelowCommittedReverts() public {
        doGift();
        vm.prank(owner);
        vm.expectRevert("below committed");
        glasses.setMaxSupply(0);
    }

    function test_LockedSupplyImmutable() public {
        vm.startPrank(owner);
        glasses.lockSupply();
        vm.expectRevert("supply locked");
        glasses.setMaxSupply(100);
        vm.stopPrank();
    }

    // ---- per-payer gift cap ---------------------------------------------

    function test_CapDefaultUnlimited() public {
        assertEq(glasses.maxGiftsPerPayer(), 0);
        // gifter can take multiple slots when uncapped
        for (uint256 i = 0; i < 3; i++) {
            vm.prank(gifter);
            glasses.gift{value: PRICE + STIPEND}(vm.addr(200 + i));
        }
        assertEq(glasses.outstandingByPayer(gifter), 3);
    }

    function test_CapBlocksSquatting() public {
        vm.prank(owner);
        glasses.setMaxGiftsPerPayer(2);
        vm.startPrank(gifter);
        glasses.gift{value: PRICE + STIPEND}(vm.addr(200));
        glasses.gift{value: PRICE + STIPEND}(vm.addr(201));
        vm.expectRevert("payer gift limit");
        glasses.gift{value: PRICE + STIPEND}(vm.addr(202));
        vm.stopPrank();
    }

    function test_RedeemFreesPayerBudget() public {
        vm.prank(owner);
        glasses.setMaxGiftsPerPayer(1);
        doGift(); // gifter -> claimAddr, now at the cap
        vm.prank(gifter);
        vm.expectRevert("payer gift limit");
        glasses.gift{value: PRICE + STIPEND}(vm.addr(200));

        // redeeming the outstanding gift returns the gifter's budget
        glasses.redeem(claimAddr, recipient, claimSig(claimKey, recipient));
        assertEq(glasses.outstandingByPayer(gifter), 0);
        vm.prank(gifter);
        glasses.gift{value: PRICE + STIPEND}(vm.addr(200)); // fits again
    }

    function test_ReclaimFreesPayerBudget() public {
        vm.prank(owner);
        glasses.setMaxGiftsPerPayer(1);
        doGift();
        vm.warp(block.timestamp + glasses.RECLAIM_AFTER());
        vm.prank(gifter);
        glasses.reclaim(claimAddr);
        assertEq(glasses.outstandingByPayer(gifter), 0);
        vm.prank(gifter);
        glasses.gift{value: PRICE + STIPEND}(vm.addr(200)); // budget restored
    }

    function test_SetCapOnlyOwner() public {
        vm.prank(gifter);
        vm.expectRevert();
        glasses.setMaxGiftsPerPayer(2);
    }

    // ---- funds -----------------------------------------------------------

    function test_WithdrawOnlyProceeds() public {
        doGift();
        // nothing redeemed: everything is escrow, owner gets nothing
        vm.prank(owner);
        glasses.withdraw();
        assertEq(owner.balance, 0);

        glasses.redeem(claimAddr, recipient, claimSig(claimKey, recipient));
        vm.prank(owner);
        glasses.withdraw();
        assertEq(owner.balance, PRICE);
        assertEq(glasses.withdrawable(), 0);
        assertEq(address(glasses).balance, 0); // stipend went to redeem caller
    }

    function test_WithdrawNotOwnerReverts() public {
        vm.prank(gifter);
        vm.expectRevert();
        glasses.withdraw();
    }

    function test_TipAbovePriceGoesToProceeds() public {
        vm.prank(gifter);
        glasses.gift{value: PRICE + STIPEND + 1 ether}(claimAddr);
        glasses.redeem(claimAddr, recipient, claimSig(claimKey, recipient));
        assertEq(glasses.withdrawable(), PRICE + 1 ether);
    }

    // ---- artwork ---------------------------------------------------------

    function setTestArt() internal {
        vm.startPrank(owner);
        glasses.setArtWrapper("A[", "]B[", "]C");
        glasses.addArtChunk("one");
        glasses.addArtChunk("two");
        vm.stopPrank();
    }

    function test_TokenHTMLAssembly() public {
        setTestArt();
        bytes32 seed = bytes32(uint256(0xbeef));
        bytes memory expected = abi.encodePacked(
            "A[", Strings.toHexString(uint256(seed), 32), "]B[", "one", "two", "]C"
        );
        assertEq(glasses.tokenHTML(seed), expected);
    }

    function test_TokenURIWellFormed() public {
        setTestArt();
        doGift();
        glasses.redeem(claimAddr, recipient, claimSig(claimKey, recipient));

        bytes memory expectedJson = abi.encodePacked(
            '{"name":"Summer Glass #1","description":"', glasses.DESCRIPTION(),
            '","animation_url":"data:text/html;base64,',
            Base64.encode(glasses.tokenHTML(glasses.seedOf(1))),
            '"}'
        );
        assertEq(
            glasses.tokenURI(1),
            string(abi.encodePacked("data:application/json;base64,", Base64.encode(expectedJson)))
        );
    }

    function test_TokenURIWithImageBase() public {
        setTestArt();
        doGift();
        glasses.redeem(claimAddr, recipient, claimSig(claimKey, recipient));
        vm.prank(owner);
        glasses.setImageBase("https://render.example/glass/");
        string memory json = string(Base64.decode(_stripJsonPrefix(glasses.tokenURI(1))));
        assertTrue(vm.contains(json, '"image":"https://render.example/glass/1"'));
        // image pointer stays mutable after the art freeze
        vm.startPrank(owner);
        glasses.freezeArt();
        glasses.setImageBase("https://better.example/");
        vm.stopPrank();
    }

    function _stripJsonPrefix(string memory uri) internal pure returns (string memory) {
        bytes memory b = bytes(uri);
        bytes memory out = new bytes(b.length - 29); // len("data:application/json;base64,")
        for (uint256 i = 0; i < out.length; i++) out[i] = b[i + 29];
        return string(out);
    }

    function test_TokenURINonexistentReverts() public {
        vm.expectRevert();
        glasses.tokenURI(1);
    }

    function test_ArtFreeze() public {
        setTestArt();
        vm.startPrank(owner);
        glasses.freezeArt();
        vm.expectRevert("art frozen");
        glasses.addArtChunk("more");
        vm.expectRevert("art frozen");
        glasses.setArtWrapper("x", "y", "z");
        vm.expectRevert("art frozen");
        glasses.clearArtChunks();
        vm.stopPrank();
    }

    function test_ArtAdminOnlyOwner() public {
        vm.prank(gifter);
        vm.expectRevert();
        glasses.addArtChunk("nope");
    }

    // ---- royalty ---------------------------------------------------------

    function test_RoyaltyDefaultZero() public view {
        (address rcv, uint256 amt) = glasses.royaltyInfo(1, 1 ether);
        assertEq(rcv, address(0));
        assertEq(amt, 0);
    }

    function test_RoyaltySettable() public {
        vm.prank(owner);
        glasses.setRoyalty(owner, 500); // 5%
        (address rcv, uint256 amt) = glasses.royaltyInfo(1, 1 ether);
        assertEq(rcv, owner);
        assertEq(amt, 0.05 ether);
        assertTrue(glasses.supportsInterface(0x2a55205a)); // ERC-2981
        assertTrue(glasses.supportsInterface(0x80ac58cd)); // ERC-721 still
    }

    function test_RoyaltyOnlyOwner() public {
        vm.prank(gifter);
        vm.expectRevert();
        glasses.setRoyalty(gifter, 500);
    }

    // ---- the real artwork ------------------------------------------------

    /// Loads the actual build output (skipped if `node build.js` hasn't run),
    /// stores it exactly as the deploy script will, and writes the assembled
    /// token HTML out for the headless-browser render check.
    function test_RealPayloadRoundTrip() public {
        if (!vm.exists("../dist/payload.b64")) {
            emit log("SKIP: run `node build.js` first");
            return;
        }
        bytes memory payload = bytes(vm.readFile("../dist/payload.b64"));
        vm.startPrank(owner);
        glasses.setArtWrapper(
            bytes(vm.readFile("../dist/art-prefix1.txt")),
            bytes(vm.readFile("../dist/art-prefix2.txt")),
            bytes(vm.readFile("../dist/art-suffix.txt"))
        );
        uint256 CHUNK = 24575;
        for (uint256 off = 0; off < payload.length; off += CHUNK) {
            uint256 len = payload.length - off < CHUNK ? payload.length - off : CHUNK;
            bytes memory part = new bytes(len);
            for (uint256 i = 0; i < len; i++) part[i] = payload[off + i];
            glasses.addArtChunk(part);
        }
        vm.stopPrank();

        doGift();
        glasses.redeem(claimAddr, recipient, claimSig(claimKey, recipient));

        uint256 g0 = gasleft();
        string memory uri = glasses.tokenURI(1);
        emit log_named_uint("tokenURI gas", g0 - gasleft());
        assertGt(bytes(uri).length, payload.length); // sanity: everything came through

        bytes memory html = glasses.tokenHTML(glasses.seedOf(1));
        vm.writeFile("../dist/.onchain-token.html", string(html));
        emit log("wrote ../dist/.onchain-token.html for the browser render check");
    }
}
