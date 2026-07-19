// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.28;

/// @notice Read/write bytes as contract code — ~200 gas/byte to write once,
/// then cheap EXTCODECOPY reads forever. Faithful port of solmate's SSTORE2
/// (Solmate: transmissions11 et al.); the leading STOP byte keeps the data
/// contract from ever being executable.
library SSTORE2 {
    uint256 internal constant DATA_OFFSET = 1; // skip the STOP prefix

    function write(bytes memory data) internal returns (address pointer) {
        bytes memory runtimeCode = abi.encodePacked(hex"00", data);
        bytes memory creationCode = abi.encodePacked(
            //---------------------------------------------------------------//
            // Opcode  | Mnemonic       | Stack        | Memory              //
            //---------------------------------------------------------------//
            // 0x60    | PUSH1 0x0b     | 0x0b         | (11 = this prefix)  //
            // 0x59    | MSIZE          | 0 0x0b       |                     //
            // 0x81    | DUP2           | 0x0b 0 0x0b  |                     //
            // 0x38    | CODESIZE       | cs 0x0b 0 .. |                     //
            // 0x03    | SUB            | rs 0 0x0b    |                     //
            // 0x80    | DUP1           | rs rs 0 ..   |                     //
            // 0x92    | SWAP3          | 0x0b rs 0 rs |                     //
            // 0x59    | MSIZE          | 0 0x0b rs 0. |                     //
            // 0x39    | CODECOPY       | 0 rs         | [0..rs): runtime    //
            // 0xf3    | RETURN         |              |                     //
            //---------------------------------------------------------------//
            hex"60_0b_59_81_38_03_80_92_59_39_f3",
            runtimeCode
        );
        assembly {
            pointer := create(0, add(creationCode, 32), mload(creationCode))
        }
        require(pointer != address(0), "SSTORE2: deploy failed");
    }

    function read(address pointer) internal view returns (bytes memory data) {
        uint256 size = pointer.code.length - DATA_OFFSET;
        assembly {
            data := mload(0x40)
            mstore(0x40, add(data, and(add(add(size, 32), 31), not(31))))
            mstore(data, size)
            extcodecopy(pointer, add(data, 32), DATA_OFFSET, size)
        }
    }
}
