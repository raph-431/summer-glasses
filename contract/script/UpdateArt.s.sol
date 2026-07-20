// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {SummerGlasses} from "../src/SummerGlasses.sol";

/// Replace the stored artwork with the current ../dist build. Only possible
/// while the art is unfrozen — i.e. during rehearsal, never after launch.
///
///   CONTRACT=0x… forge script script/UpdateArt.s.sol \
///     --rpc-url <rpc> --account <name> --sender <addr> --broadcast
contract UpdateArt is Script {
    uint256 constant CHUNK = 24575;

    function run() external {
        SummerGlasses glasses = SummerGlasses(payable(vm.envAddress("CONTRACT")));
        require(!glasses.artFrozen(), "art is frozen: nothing can change it");

        bytes memory payload = bytes(vm.readFile("../dist/payload.b64"));

        vm.startBroadcast();
        glasses.clearArtChunks();
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

        console.log("art replaced; chunks:", glasses.artChunkCount());
    }
}
