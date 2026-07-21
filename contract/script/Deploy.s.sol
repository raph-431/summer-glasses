// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {SummerGlasses} from "../src/SummerGlasses.sol";

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
        uint256 giftCap = vm.envOr("MAX_GIFTS_PER_PAYER", uint256(0)); // 0 = unlimited

        bytes memory payload = bytes(vm.readFile("../dist/payload.b64"));

        vm.startBroadcast();
        SummerGlasses glasses = new SummerGlasses(price, stipend, supply);
        if (giftCap != 0) glasses.setMaxGiftsPerPayer(giftCap);
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
        console.log("art chunks:", glasses.artChunkCount());
        console.log("price (wei):", price);
        console.log("stipend (wei):", stipend);
        console.log("max supply:", supply);
        console.log("max gifts/payer (0=unlimited):", giftCap);
    }
}
