// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {SummerGlasses} from "../src/SummerGlasses.sol";
import {GiftReceipt} from "../src/GiftReceipt.sol";
import {Base64} from "openzeppelin-contracts/utils/Base64.sol";

contract GiftReceiptTest is Test {
    SummerGlasses glasses;
    GiftReceipt receipt;

    uint256 constant PRICE = 0.01 ether;
    uint96 constant STIPEND = 0.001 ether;
    uint256 constant SUPPLY = 8;

    address owner = makeAddr("owner");
    address gifter = makeAddr("gifter");
    address relayer = makeAddr("relayer");
    address recipient = makeAddr("recipient");

    uint256 claimKey;
    address claimAddr;

    receive() external payable {}

    function setUp() public {
        vm.startPrank(owner);
        receipt = new GiftReceipt();
        glasses = new SummerGlasses(PRICE, STIPEND, SUPPLY);
        receipt.setMinter(address(glasses));
        glasses.setReceipt(address(receipt));
        vm.stopPrank();
        (claimAddr, claimKey) = makeAddrAndKey("claim-key");
        vm.deal(gifter, 10 ether);
    }

    function doGift(address claim) internal {
        vm.prank(gifter);
        glasses.gift{value: PRICE + STIPEND}(claim);
    }

    // ---- wiring is one-time and locked ----------------------------------

    function test_SetMinterOnlyOnce() public {
        vm.prank(owner);
        vm.expectRevert("minter set");
        receipt.setMinter(address(0xBEEF));
    }

    function test_SetMinterZeroReverts() public {
        GiftReceipt fresh = new GiftReceipt();
        vm.prank(address(this)); // this contract is fresh's owner
        vm.expectRevert("zero minter");
        fresh.setMinter(address(0));
    }

    function test_SetMinterOnlyOwner() public {
        GiftReceipt fresh = new GiftReceipt();
        vm.prank(gifter);
        vm.expectRevert();
        fresh.setMinter(address(glasses));
    }

    function test_SetReceiptOnlyOnce() public {
        vm.prank(owner);
        vm.expectRevert("receipt set");
        glasses.setReceipt(address(0xBEEF));
    }

    function test_MintOnlyMinter() public {
        vm.prank(gifter);
        vm.expectRevert("only minter");
        receipt.mint(gifter);
    }

    // ---- gift() hands the payer a receipt --------------------------------

    function test_GiftMintsReceiptToPayer() public {
        doGift(claimAddr);
        assertEq(receipt.ownerOf(1), gifter);
        assertEq(receipt.balanceOf(gifter), 1);
        assertEq(receipt.giftedAt(1), block.timestamp);
    }

    function test_EachGiftMintsAReceipt() public {
        doGift(claimAddr);
        doGift(makeAddr("claim2"));
        assertEq(receipt.balanceOf(gifter), 2);
        assertEq(receipt.ownerOf(2), gifter);
    }

    /// the keepsake is a normal, freely transferable ERC-721
    function test_ReceiptTransferable() public {
        doGift(claimAddr);
        vm.prank(gifter);
        receipt.transferFrom(gifter, recipient, 1);
        assertEq(receipt.ownerOf(1), recipient);
    }

    /// receipts have their own counter and never touch glass supply
    function test_ReceiptDoesNotConsumeGlassSupply() public {
        for (uint256 i = 0; i < SUPPLY; i++) doGift(vm.addr(200 + i));
        assertEq(receipt.balanceOf(gifter), SUPPLY); // SUPPLY receipts minted
        // ...but the glass edition is exactly full, no over/undercount
        vm.prank(gifter);
        vm.expectRevert("sold out");
        glasses.gift{value: PRICE + STIPEND}(vm.addr(999));
    }

    /// gifting still works if no receipt is ever bound (backwards-compatible)
    function test_GiftWithoutReceiptStillWorks() public {
        vm.prank(owner);
        SummerGlasses bare = new SummerGlasses(PRICE, STIPEND, SUPPLY);
        vm.prank(gifter);
        bare.gift{value: PRICE + STIPEND}(claimAddr);
        (address payer,,,) = bare.gifts(claimAddr);
        assertEq(payer, gifter);
    }

    // ---- metadata --------------------------------------------------------

    function _json(uint256 id) internal view returns (string memory) {
        string memory uri = receipt.tokenURI(id);
        bytes memory b = bytes(uri);
        uint256 skip = 29; // len("data:application/json;base64,")
        bytes memory enc = new bytes(b.length - skip);
        for (uint256 i = 0; i < enc.length; i++) enc[i] = b[i + skip];
        return string(Base64.decode(string(enc)));
    }

    function test_TokenURIShapeAndContent() public {
        doGift(claimAddr);
        string memory json = _json(1);
        assertTrue(vm.contains(json, '"name":"Gift Receipt #1"'));
        assertTrue(vm.contains(json, "data:image/svg+xml;base64,"));
        assertTrue(vm.contains(json, "cannot redeem")); // it disclaims itself
    }

    function test_DateFormatting() public {
        // (timestamp, expected date, expected time) verified against `date -u`
        _assertGiftedAt(1753281120, vm.addr(1), "23 July 2025", "14:32 UTC");
        _assertGiftedAt(946684800,  vm.addr(2), "1 January 2000", "00:00 UTC");
        _assertGiftedAt(0,          vm.addr(3), "1 January 1970", "00:00 UTC");
        _assertGiftedAt(4102444800, vm.addr(4), "1 January 2100", "00:00 UTC");
    }

    function _assertGiftedAt(uint256 ts, address claim, string memory date, string memory time) internal {
        vm.warp(ts);
        doGift(claim);
        uint256 id = receipt.nextId() - 1;
        string memory json = _json(id);
        assertTrue(vm.contains(json, date), date);
        assertTrue(vm.contains(json, time), time);
    }
}
