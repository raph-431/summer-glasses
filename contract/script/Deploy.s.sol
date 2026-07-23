// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {SummerGlasses} from "../src/SummerGlasses.sol";
import {GiftReceipt} from "../src/GiftReceipt.sol";

/// Deploys the contract and uploads the artwork from ../dist (run
/// `node build.js` first). Art is NOT frozen here — freeze at launch, after
/// the on-chain render has been eyeballed:
///   cast send <addr> "freezeArt()" ...
///
///   PRICE=... STIPEND=... MAX_SUPPLY=... \
///   forge script script/Deploy.s.sol --rpc-url <rpc> --private-key <pk> --broadcast
contract Deploy is Script {
    uint256 constant CHUNK = 24575; // SSTORE2 max payload per data contract

    function run() external {
        uint256 price = vm.envOr("PRICE", uint256(0.002 ether));
        uint96 stipend = uint96(vm.envOr("STIPEND", uint256(0.00005 ether)));
        uint256 supply = vm.envOr("MAX_SUPPLY", uint256(256));

        bytes memory payload = bytes(vm.readFile("../dist/payload.b64"));

        vm.startBroadcast();
        // SummerGlasses first so it keeps anvil's well-known first-deploy
        // address (see web/config.js), then the receipt, then wire the two.
        SummerGlasses glasses = new SummerGlasses(price, stipend, supply);
        GiftReceipt receipt = new GiftReceipt();
        // one-time bindings: only the glasses contract can mint receipts, and
        // the glasses contract mints one keepsake per gift()
        receipt.setMinter(address(glasses));
        glasses.setReceipt(address(receipt));
        glasses.setArtWrapper(
            bytes(vm.readFile("../dist/art-prefix1.txt")),
            bytes(vm.readFile("../dist/art-prefix2.txt")),
            bytes(vm.readFile("../dist/art-suffix.txt"))
        );
        for (uint256 off = 0; off < payload.length; off += CHUNK) {
            uint256 len = payload.length - off < CHUNK ? payload.length - off : CHUNK;
            bytes memory part = new bytes(len);
            for (uint256 i = 0; i < len; i++) part[i] = payload[off + i];
            glasses.addArtChunk(part);
        }
        vm.stopBroadcast();

        console.log("SummerGlasses deployed:", address(glasses));
        console.log("GiftReceipt deployed:", address(receipt));
        console.log("art chunks:", glasses.artChunkCount());
        console.log("price (wei):", price);
        console.log("stipend (wei):", stipend);
        console.log("max supply:", supply);
    }
}
