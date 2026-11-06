// SPDX-License-Identifier: LicenseRef-Degensoft-SwapVM-1.1
pragma solidity 0.8.30;

/// @custom:license-url https://github.com/1inch/swap-vm/blob/main/LICENSES/SwapVM-1.1.txt
/// @custom:copyright Modified SwapVM — © Degensoft Ltd 2025. Modifications © 2026 Nivesh Gajengi.
/// @custom:change 2026-11-06 (Noren): copy of upstream AquaSwapVMRouter v1.0.2 with one instruction
/// appended to the AquaOpcodes table (NorenOraclePeg at opcode 34). Opcodes 0-33 are unchanged.

import { Context } from "@1inch/swap-vm/src/libs/VM.sol";
import { Simulator } from "@1inch/solidity-utils/contracts/mixins/Simulator.sol";

import { SwapVM } from "@1inch/swap-vm/src/SwapVM.sol";
import { AquaOpcodes } from "@1inch/swap-vm/src/opcodes/AquaOpcodes.sol";
import { NorenOraclePeg } from "../instructions/NorenOraclePeg.sol";

/// @title NorenAquaSwapVMRouter
/// @notice The official AquaSwapVMRouter (SwapVM v1.0.2, deployed by 1inch at
/// 0x111111338c5091E8440b67B168bAe16a668AC0De on Robinhood Chain) plus NorenOraclePeg, a
/// Chainlink-pegged pricing instruction. Settlement, order hashing, Aqua pull/push and every
/// upstream instruction are untouched. Redeployed on a local Robinhood fork against the official
/// Aqua registry 0x1111113ccf1426a8e30e2bff5e005d929bf6a90a.
contract NorenAquaSwapVMRouter is Simulator, SwapVM, AquaOpcodes, NorenOraclePeg {
    /// @notice Opcode of NorenOraclePeg: the first slot after the 34 upstream AquaOpcodes.
    uint8 public constant NOREN_ORACLE_PEG_OPCODE = 34;

    error NorenRouterOpcodeTableChanged(uint256 upstreamLength);

    constructor(address aqua, address weth, address owner, string memory name, string memory version)
        SwapVM(aqua, weth, owner, name, version)
        AquaOpcodes(aqua)
        NorenOraclePeg(aqua)
    {
        require(_opcodes().length == NOREN_ORACLE_PEG_OPCODE, NorenRouterOpcodeTableChanged(_opcodes().length));
    }

    /// @dev Upstream AquaOpcodes table with NorenOraclePeg appended.
    function _instructions() internal pure override returns (function(Context memory, bytes calldata) internal[] memory result) {
        function(Context memory, bytes calldata) internal[] memory upstream = _opcodes();
        result = new function(Context memory, bytes calldata) internal[](upstream.length + 1);
        for (uint256 i = 0; i < upstream.length; i++) {
            result[i] = upstream[i];
        }
        result[upstream.length] = NorenOraclePeg._norenOraclePeg1D;
    }
}
