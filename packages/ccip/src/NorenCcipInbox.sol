// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {INorenActionSink} from "./interfaces/INorenActionSink.sol";
import {NorenArcAction} from "./libraries/NorenArcAction.sol";

/// @title NorenCcipInbox
/// @notice The app behind NorenCcipGateway on chains other than Arc (Robinhood Chain on the reverse path).
///         It keeps the latest Arc-side utilisation of each credit line (LINE_REPORT from the Arc router), newest
///         `asOf` wins so out-of-order delivery cannot roll a line back, and records every other message's hash.
/// @dev Unaudited hackathon code.
contract NorenCcipInbox is INorenActionSink, Ownable2Step {
  using SafeERC20 for IERC20;

  struct LineReport {
    uint256 drawn;
    uint256 repaid;
    uint64 asOf;
    uint64 source;
    address borrower;
    bytes32 messageId;
  }

  address public gateway;
  /// @notice Accounts on other chains allowed to send LINE_REPORTs (the NorenArcActionRouter on Arc).
  mapping(uint64 source => mapping(address sender => bool)) public reporter;
  mapping(bytes32 lineId => LineReport) public lineReports;
  mapping(bytes32 msgId => bytes32 actionHash) public records;
  mapping(address account => mapping(address token => uint256)) public claimable;

  event GatewaySet(address indexed gateway);
  event ReporterSet(uint64 indexed source, address indexed sender, bool allowed);
  event LineReportUpdated(bytes32 indexed lineId, address indexed borrower, uint256 drawn, uint256 repaid, uint64 asOf, bytes32 messageId);
  event LineReportStale(bytes32 indexed lineId, uint64 asOf, uint64 storedAsOf);
  event MessageRecorded(bytes32 indexed msgId, uint64 indexed source, address indexed sourceSender, uint8 kind, bytes32 actionHash);
  event Claimed(address indexed account, address indexed token, uint256 amount);

  error NotGateway(address caller);
  error NothingToClaim();

  constructor(address gateway_, address owner_) Ownable(owner_) {
    gateway = gateway_;
    emit GatewaySet(gateway_);
  }

  function setGateway(address gateway_) external onlyOwner {
    gateway = gateway_;
    emit GatewaySet(gateway_);
  }

  function setReporter(uint64 source, address sender, bool allowed) external onlyOwner {
    reporter[source][sender] = allowed;
    emit ReporterSet(source, sender, allowed);
  }

  /// @inheritdoc INorenActionSink
  function execute(bytes32, bytes32 msgId, uint64 source, address sourceSender, address token, uint256 amount, bytes calldata action)
    external
    returns (bool ok)
  {
    if (msg.sender != gateway) revert NotGateway(msg.sender);
    if (amount != 0) claimable[sourceSender][token] += amount;
    bytes32 h = keccak256(action);
    records[msgId] = h;
    uint8 kind;
    if (action.length >= 128) {
      NorenArcAction.Action memory a = NorenArcAction.decode(action);
      kind = a.kind;
      if (a.kind == NorenArcAction.LINE_REPORT && reporter[source][sourceSender]) {
        (bytes32 lineId, uint256 drawn, uint256 repaid, uint64 asOf) = abi.decode(a.params, (bytes32, uint256, uint256, uint64));
        LineReport storage r = lineReports[lineId];
        if (asOf <= r.asOf) {
          emit LineReportStale(lineId, asOf, r.asOf);
        } else {
          lineReports[lineId] = LineReport(drawn, repaid, asOf, source, a.beneficiary, msgId);
          emit LineReportUpdated(lineId, a.beneficiary, drawn, repaid, asOf, msgId);
        }
      }
    }
    emit MessageRecorded(msgId, source, sourceSender, kind, h);
    return true;
  }

  function claim(address token) external {
    uint256 amt = claimable[msg.sender][token];
    if (amt == 0) revert NothingToClaim();
    claimable[msg.sender][token] = 0;
    IERC20(token).safeTransfer(msg.sender, amt);
    emit Claimed(msg.sender, token, amt);
  }
}
