// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, Vm} from "forge-std/Test.sol";
import {IRouter} from "@chainlink/contracts-ccip/contracts/interfaces/IRouter.sol";
import {IAny2EVMMessageReceiverV2} from "@chainlink/contracts-ccip/contracts/interfaces/IAny2EVMMessageReceiverV2.sol";
import {Client} from "@chainlink/contracts-ccip/contracts/libraries/Client.sol";
import {MessageV1Codec} from "@chainlink/contracts-ccip/contracts/libraries/MessageV1Codec.sol";
import {FinalityCodec} from "@chainlink/contracts-ccip/contracts/libraries/FinalityCodec.sol";

/// @dev Decodes the OnRamp's wire-format message (MessageV1Codec takes calldata).
contract MessageV1Decoder {
  function decode(bytes calldata encoded) external pure returns (MessageV1Codec.MessageV1 memory) {
    return MessageV1Codec._decodeMessageV1(encoded);
  }

  function checkFinality(bytes4 requested, bytes4 allowed) external pure {
    FinalityCodec._ensureRequestedFinalityAllowed(requested, allowed);
  }
}

/// @title CcipForkBase
/// @notice Fork harness over the public testnets. Everything on-chain is the real deployed Chainlink code:
///         sends go through the real Router and CCIP 2.0 OnRamp (fee quoting, extra-args validation, event
///         encoding); delivery calls the real destination Router's `routeMessage` as the real OffRamp, exactly as
///         the OffRamp does after the DON's verifiers sign. The only thing not reproduced is the off-chain DON
///         (verifier signatures and executor), so this is the Chainlink Local fork pattern, not a live run.
abstract contract CcipForkBase is Test {
  // CCIP chain selectors (Chainlink CCIP directory API, testnet)
  uint64 internal constant RH = 2032988798112970440; // Robinhood Chain Testnet 46630
  uint64 internal constant BASE = 10344971235874465080; // Base Sepolia 84532
  uint64 internal constant ARC = 3034092155422581607; // Arc Testnet 5042002
  uint64 internal constant SEP = 16015286601757825753; // Ethereum Sepolia 11155111

  // Routers (CCIP directory; each verified with eth_getCode in setUp)
  address internal constant RH_ROUTER = 0x30D197C6F5bE050D5525dD94d01760FaCdB67e7C;
  address internal constant BASE_ROUTER = 0xD3b06cEbF099CE7DA4AcCf578aaebFDBd6e88a93;
  address internal constant ARC_ROUTER = 0xdE4E7FED43FAC37EB21aA0643d9852f75332eab8;
  address internal constant SEP_ROUTER = 0x0BF3dE8c5D3e8A2B34D2BEeB17ABfCeBaf363A59;

  // CCIP 2.0 ramps, one OnRamp and one OffRamp per chain. Read from each Router (getOnRamp / getOffRamps) and
  // typeAndVersion on Nov 6 2026; each Router also still lists a 1.6.0 OffRamp for older messages.
  address internal constant RH_ONRAMP = 0xFdf08F0e789682b00046837C424187d893d15083; // OnRamp 2.0.0
  address internal constant RH_OFFRAMP = 0x6ad7dF87388A8f07f980D87974Aa62417a0F6471; // OffRamp 2.0.0
  address internal constant BASE_ONRAMP = 0xA33b221A8427739c76f631a995ca60544bEdD632; // OnRamp 2.0.0
  address internal constant BASE_OFFRAMP = 0xa137536A3BFd81aD6f090981268b8C2818451d41; // OffRamp 2.0.0
  address internal constant ARC_ONRAMP = 0x0409822AC30A1A74fCE849E6163a86cF18fe1863; // OnRamp 2.0.0
  address internal constant ARC_OFFRAMP = 0xAB7a0743AC17D293e0A34f704367331Ec23D748f; // OffRamp 2.0.0
  address internal constant SEP_ONRAMP = 0x8dcf17f298c881A547D91ca4aA3C2AD7568C6777; // OnRamp 2.0.0

  // OnRamp 2.0: CCIPMessageSent(uint64 indexed destChainSelector, address indexed sender, bytes32 indexed messageId,
  //   address feeToken, uint256 tokenAmountBeforeTokenPoolFees, bytes encodedMessage, Receipt[] receipts, bytes[] verifierBlobs)
  bytes32 internal constant CCIP_MESSAGE_SENT_TOPIC = keccak256(
    "CCIPMessageSent(uint64,address,bytes32,address,uint256,bytes,(address,uint32,uint32,uint256,bytes)[],bytes[])"
  );

  uint256 internal rhFork;
  uint256 internal baseFork;
  uint256 internal arcFork;
  uint256 internal sepFork;

  struct Sent {
    bytes32 messageId;
    uint64 source;
    uint64 dest;
    address receiver;
    uint32 gasLimit;
    bytes4 finality;
    Client.Any2EVMMessage message;
  }

  function _forks() internal {
    rhFork = vm.createFork(vm.rpcUrl("robinhood_testnet"));
    baseFork = vm.createFork(vm.rpcUrl("base_sepolia"));
    arcFork = vm.createFork(vm.rpcUrl("arc_testnet"));
    sepFork = vm.createFork(vm.rpcUrl("ethereum_sepolia"));
    _assertCode(rhFork, RH_ROUTER);
    _assertCode(rhFork, RH_ONRAMP);
    _assertCode(rhFork, RH_OFFRAMP);
    _assertCode(baseFork, BASE_ONRAMP);
    _assertCode(arcFork, ARC_ONRAMP);
    _assertCode(sepFork, SEP_ONRAMP);
    _assertCode(baseFork, BASE_ROUTER);
    _assertCode(baseFork, BASE_OFFRAMP);
    _assertCode(arcFork, ARC_ROUTER);
    _assertCode(arcFork, ARC_OFFRAMP);
    _assertCode(sepFork, SEP_ROUTER);
  }

  function _assertCode(uint256 fork, address a) internal {
    vm.selectFork(fork);
    assertGt(a.code.length, 0, "no code at CCIP address");
  }

  /// @dev Pulls the OnRamp's CCIPMessageSent out of the recorded logs and rebuilds the Any2EVMMessage the
  ///      destination OffRamp would route.
  function _sentFromLogs(Vm.Log[] memory logs, address onRamp) internal returns (Sent memory s) {
    MessageV1Decoder dec = new MessageV1Decoder();
    for (uint256 i = 0; i < logs.length; i++) {
      if (logs[i].emitter != onRamp || logs[i].topics[0] != CCIP_MESSAGE_SENT_TOPIC) continue;
      (, , bytes memory encoded) = abi.decode(logs[i].data, (address, uint256, bytes));
      MessageV1Codec.MessageV1 memory m = dec.decode(encoded);
      s.messageId = keccak256(encoded);
      assertEq(s.messageId, logs[i].topics[3], "messageId != keccak(encodedMessage)");
      s.source = m.sourceChainSelector;
      s.dest = m.destChainSelector;
      s.receiver = address(bytes20(m.receiver));
      s.gasLimit = m.ccipReceiveGasLimit;
      s.finality = m.finality;
      Client.EVMTokenAmount[] memory toks = new Client.EVMTokenAmount[](m.tokenTransfer.length);
      for (uint256 t = 0; t < m.tokenTransfer.length; t++) {
        toks[t] = Client.EVMTokenAmount({token: address(bytes20(m.tokenTransfer[t].destTokenAddress)), amount: m.tokenTransfer[t].amount});
      }
      s.message = Client.Any2EVMMessage({
        messageId: s.messageId,
        sourceChainSelector: m.sourceChainSelector,
        sender: m.sender,
        data: m.data,
        destTokenAmounts: toks
      });
      return s;
    }
    revert("no CCIPMessageSent from the OnRamp");
  }

  /// @dev Delivers `s` on `fork` through the real Router as the real OffRamp, after the same receiver-finality
  ///      check the OffRamp performs. Returns the Router's (success, returnData, gasUsed).
  function _route(uint256 fork, address router, address offRamp, Sent memory s)
    internal
    returns (bool ok, bytes memory ret, uint256 gasUsed)
  {
    vm.selectFork(fork);
    assertTrue(IRouter(router).isOffRamp(s.source, offRamp), "offRamp not registered for source on router");
    (,,, bytes4 allowed) = IAny2EVMMessageReceiverV2(s.receiver).getCCVsAndFinalityConfig(s.source, s.message.sender);
    MessageV1Decoder dec = new MessageV1Decoder();
    dec.checkFinality(s.finality, allowed);
    vm.prank(offRamp);
    (ok, ret, gasUsed) = IRouter(router).routeMessage(s.message, 5_000, s.gasLimit, s.receiver);
  }
}
