// Noren credit bridge: a Chainlink CRE workflow that carries the Noren credit line between
// Robinhood Chain and Arc. CRE carries messages only; no tokens cross chains.
//
//   handler 0  Robinhood  NorenCredit.CreditLineOpened  -> Arc        NorenCreditLine.onReport(borrower, lineId, limit, expiry)
//   handler 1  Robinhood  NorenCredit.CreditLineClosed  -> Arc        NorenCreditLine.onReport(borrower, lineId, 0, expiry)
//   handler 2  Arc        NorenCreditLine.Drawn/Repaid/CreditLineFrozen
//                                                         -> Robinhood  NorenCredit.onReport(lineId, drawn, repaid, asOf)
//
//   handler 3  HTTP       World ID server's starter request     -> Arc        NorenCreditLine.onReport(kind 2)
//
// Each write is a DON-signed report delivered through the chain's CRE forwarder; the receivers
// accept onReport only from that forwarder.
import {
  bytesToHex,
  EVMClient,
  encodeCallMsg,
  getNetwork,
  decodeJson,
  handler,
  HTTPCapability,
  LATEST_BLOCK_NUMBER,
  logTriggerConfig,
  prepareReportRequest,
  protoBigIntToBigint,
  blockNumber as toBlockNumber,
  Runner,
  TxStatus,
  type EVMLog,
  type HTTPPayload,
  type Runtime,
} from "@chainlink/cre-sdk";
import { decodeFunctionResult, encodeFunctionData, zeroAddress, type Address, type Hex } from "viem";
import {
  creditLineAbi,
  decideClose,
  decideHumanStarter,
  parseHumanStarterPayload,
  decideOpen,
  decideUtilisation,
  decodeArcActivity,
  decodeClosed,
  decodeOpened,
  formatUsdc,
  TOPIC,
  harnessUtilisationAbi,
  LINE_STATUS,
  robinhoodLineAbi,
  validateConfig,
  type ArcLine,
  type BridgeConfig,
  type ChainTarget,
  type Decision,
  type RawLog,
} from "./bridge";

export type Config = BridgeConfig;

const evmFor = (target: ChainTarget): EVMClient => {
  const network = getNetwork({ chainFamily: "evm", chainSelectorName: target.chainSelectorName, isTestnet: true });
  if (!network) throw new Error(`unknown CRE chain ${target.chainSelectorName}`);
  return new EVMClient(network.chainSelector.selector);
};

const rawLog = (log: EVMLog): RawLog => ({
  address: bytesToHex(log.address),
  topics: log.topics.map((t) => bytesToHex(t)),
  data: bytesToHex(log.data),
});

const describeLog = (log: EVMLog): string =>
  `tx ${bytesToHex(log.txHash)} log ${log.index}${log.blockNumber ? ` block ${protoBigIntToBigint(log.blockNumber)}` : ""}`;

type ReadAt = typeof LATEST_BLOCK_NUMBER | ReturnType<typeof toBlockNumber>;

const read = (runtime: Runtime<Config>, evm: EVMClient, to: Address, data: Hex, at: ReadAt): Hex => {
  const reply = evm.callContract(runtime, { call: encodeCallMsg({ from: zeroAddress, to, data }), blockNumber: at }).result();
  return bytesToHex(reply.data);
};

const readArcLine = (runtime: Runtime<Config>, evm: EVMClient, lineId: Hex): ArcLine => {
  const { address } = runtime.config.arc;
  const data = read(runtime, evm, address, encodeFunctionData({ abi: creditLineAbi, functionName: "lines", args: [lineId] }), LATEST_BLOCK_NUMBER);
  if (data === "0x") throw new Error(`NorenCreditLine not found at ${address} on ${runtime.config.arc.chainSelectorName}`);
  const l = decodeFunctionResult({ abi: creditLineAbi, functionName: "lines", data });
  return { borrower: l.borrower, expiry: l.expiry, updatedAt: l.updatedAt, closed: l.closed, limitUsdc6: l.limitUsdc6, unsecured: l.unsecured };
};

/** Sign `decision.report` with the DON and deliver it to `target` through its CRE forwarder. */
const deliver = (runtime: Runtime<Config>, evm: EVMClient, target: ChainTarget, decision: Decision, receiverName: string): string => {
  if (!decision.write) {
    runtime.log(`No write: ${decision.reason}`);
    return JSON.stringify({ status: "skipped", reason: decision.reason });
  }
  runtime.log(`Report: ${decision.summary}`);
  const report = runtime.report(prepareReportRequest(decision.report)).result();
  const reply = evm.writeReport(runtime, { receiver: target.address, report, gasConfig: { gasLimit: target.gasLimit } }).result();
  const txHash = reply.txHash && reply.txHash.length > 0 ? bytesToHex(reply.txHash) : null;
  if (reply.txStatus !== TxStatus.SUCCESS) {
    throw new Error(`writeReport to ${receiverName} failed: status ${TxStatus[reply.txStatus]} tx ${txHash} ${reply.errorMessage ?? ""}`);
  }
  // ReceiverContractExecutionStatus.REVERTED = 1: the forwarder tx landed but onReport reverted.
  if (reply.receiverContractExecutionStatus === 1) {
    throw new Error(`${receiverName}.onReport reverted inside the forwarder call (tx ${txHash})`);
  }
  if (!txHash) {
    // `cre workflow simulate` without --broadcast signs the report but sends nothing.
    runtime.log(`Report signed for ${receiverName}; not broadcast, nothing sent`);
    return JSON.stringify({ status: "not-broadcast", receiver: target.address, report: decision.report });
  }
  runtime.log(`${receiverName} updated on ${target.chainSelectorName}: tx ${txHash}`);
  return JSON.stringify({ status: "written", receiver: target.address, report: decision.report, txHash });
};

// ---------------------------------------------------------------- handler 0: Robinhood -> Arc (open)

export const onCreditLineOpened = (runtime: Runtime<Config>, log: EVMLog): string => {
  const config = runtime.config;
  validateConfig(config);
  const ev = decodeOpened(rawLog(log), config.robinhood.address);
  runtime.log(
    `CreditLineOpened on ${config.robinhood.chainSelectorName} (${describeLog(log)}): line ${ev.lineId} borrower ${ev.borrower} limit ${formatUsdc(ev.limitUsdc6)} USDC expiry ${ev.expiry} collateral $${Number(ev.collateralValueUsd8 / 1_000_000n) / 100}`,
  );
  const arc = evmFor(config.arc);
  const now = BigInt(Math.floor(runtime.now().getTime() / 1000));
  const decision = decideOpen(ev, readArcLine(runtime, arc, ev.lineId), now, BigInt(config.maxLimitUsdc6));
  return deliver(runtime, arc, config.arc, decision, "NorenCreditLine");
};

// ---------------------------------------------------------------- handler 1: Robinhood -> Arc (close)

export const onCreditLineClosed = (runtime: Runtime<Config>, log: EVMLog): string => {
  const config = runtime.config;
  validateConfig(config);
  const lineId = decodeClosed(rawLog(log), config.robinhood.address);
  runtime.log(`CreditLineClosed on ${config.robinhood.chainSelectorName} (${describeLog(log)}): line ${lineId}`);
  const arc = evmFor(config.arc);
  return deliver(runtime, arc, config.arc, decideClose(lineId, readArcLine(runtime, arc, lineId)), "NorenCreditLine");
};

/** One optional eth_call: decoded result, or null if the call reverts, returns nothing or fails to decode. */
const tryRead = <T,>(runtime: Runtime<Config>, what: string, fn: () => T): T | null => {
  try {
    return fn();
  } catch (e) {
    runtime.log(`Optional read ${what} unavailable: ${(e instanceof Error ? e.message : String(e)).slice(0, 160)}`);
    return null;
  }
};

/**
 * The Robinhood receiver's last accepted Arc asOf, used only to skip a write it would reject as
 * stale. Tries utilisation(bytes32) (NorenCredit's dedicated view, and the test harness), then
 * NorenCredit.line(bytes32). Neither is required: if both are missing or revert, the workflow writes
 * without the pre-check and the receiver's own stale check decides. Never fails the workflow.
 */
export const readRobinhoodAsOf = (runtime: Runtime<Config>, robinhood: EVMClient, lineId: Hex): bigint | null => {
  const { address } = runtime.config.robinhood;
  const viaUtilisation = tryRead(runtime, "utilisation(bytes32)", () => {
    const data = read(runtime, robinhood, address, encodeFunctionData({ abi: harnessUtilisationAbi, functionName: "utilisation", args: [lineId] }), LATEST_BLOCK_NUMBER);
    return decodeFunctionResult({ abi: harnessUtilisationAbi, functionName: "utilisation", data });
  });
  if (viaUtilisation) {
    runtime.log(`Robinhood utilisation: drawn ${formatUsdc(viaUtilisation[0])} repaid ${formatUsdc(viaUtilisation[1])} asOf ${viaUtilisation[2]}`);
    return viaUtilisation[2];
  }
  const viaLine = tryRead(runtime, "line(bytes32)", () => {
    const data = read(runtime, robinhood, address, encodeFunctionData({ abi: robinhoodLineAbi, functionName: "line", args: [lineId] }), LATEST_BLOCK_NUMBER);
    return decodeFunctionResult({ abi: robinhoodLineAbi, functionName: "line", data });
  });
  if (viaLine) {
    runtime.log(`NorenCredit line: status ${LINE_STATUS[viaLine.status] ?? viaLine.status}, drawn ${formatUsdc(viaLine.drawn)} repaid ${formatUsdc(viaLine.repaid)} asOf ${viaLine.asOf}`);
    return viaLine.asOf;
  }
  runtime.log("Robinhood receiver has no readable asOf view; writing without the pre-check (its own stale check decides)");
  return null;
};

// ---------------------------------------------------------------- handler 2: Arc -> Robinhood (utilisation)

export const onArcActivity = (runtime: Runtime<Config>, log: EVMLog): string => {
  const config = runtime.config;
  validateConfig(config);
  const act = decodeArcActivity(rawLog(log), config.arc.address);
  runtime.log(
    `${act.kind} on ${config.arc.chainSelectorName} (${describeLog(log)}): line ${act.lineId}${act.kind === "CreditLineFrozen" ? "" : ` ${formatUsdc(act.amount)} USDC`}${act.merchant ? ` to merchant ${act.merchant} invoice ${act.invoiceId}` : ""}`,
  );
  if (!log.blockNumber) throw new Error("log has no block number; cannot read the snapshot at its block");
  const arc = evmFor(config.arc);
  // Cumulative totals at the log's block: every node reads the same block, so the report is deterministic.
  const at = toBlockNumber(protoBigIntToBigint(log.blockNumber));
  const snapData = read(runtime, arc, config.arc.address, encodeFunctionData({ abi: creditLineAbi, functionName: "lines", args: [act.lineId] }), at);
  if (snapData === "0x") throw new Error(`NorenCreditLine not found at ${config.arc.address}`);
  const snap = decodeFunctionResult({ abi: creditLineAbi, functionName: "lines", data: snapData });
  const snapshot = { drawnUsdc6: snap.drawnUsdc6, repaidUsdc6: snap.repaidUsdc6, asOf: snap.updatedAt, unsecured: snap.unsecured };
  if (snapshot.unsecured) return deliver(runtime, arc, config.arc, decideUtilisation(act.lineId, snapshot, null), "NorenCredit");

  const robinhood = evmFor(config.robinhood);
  const robinhoodAsOf = readRobinhoodAsOf(runtime, robinhood, act.lineId);
  const decision = decideUtilisation(act.lineId, snapshot, robinhoodAsOf);
  return deliver(runtime, robinhood, config.robinhood, decision, "NorenCredit");
};

// ---------------------------------------------------------------- handler 3: World ID starter limit (HTTP)

export const onHumanStarter = (runtime: Runtime<Config>, payload: HTTPPayload): string => {
  const config = runtime.config;
  validateConfig(config);
  const req = parseHumanStarterPayload(decodeJson(payload.input));
  runtime.log(
    `World ID starter request: borrower ${req.borrower} nullifier ${req.nullifierHash} limit ${formatUsdc(req.limitUsdc6)} USDC expiry ${req.expiry} line ${req.lineId}`,
  );
  const arc = evmFor(config.arc);
  const at = LATEST_BLOCK_NUMBER;
  const usedData = read(runtime, arc, config.arc.address, encodeFunctionData({ abi: creditLineAbi, functionName: "nullifierUsedBy", args: [req.nullifierHash] }), at);
  if (usedData === "0x") throw new Error(`NorenCreditLine not found at ${config.arc.address}`);
  const nullifierUsedBy = decodeFunctionResult({ abi: creditLineAbi, functionName: "nullifierUsedBy", data: usedData });
  const capData = read(runtime, arc, config.arc.address, encodeFunctionData({ abi: creditLineAbi, functionName: "maxStarterLimitUsdc6" }), at);
  const maxStarterLimitUsdc6 = decodeFunctionResult({ abi: creditLineAbi, functionName: "maxStarterLimitUsdc6", data: capData });
  const now = BigInt(Math.floor(runtime.now().getTime() / 1000));
  const decision = decideHumanStarter(req, { nullifierUsedBy, maxStarterLimitUsdc6, line: readArcLine(runtime, arc, req.lineId) }, now);
  return deliver(runtime, arc, config.arc, decision, "NorenCreditLine");
};

export const initWorkflow = (config: Config) => {
  validateConfig(config);
  const robinhood = evmFor(config.robinhood);
  const arc = evmFor(config.arc);
  return [
    handler(
      robinhood.logTrigger(logTriggerConfig({ addresses: [config.robinhood.address], topics: [[TOPIC.creditLineOpened]], confidence: config.confidence })),
      onCreditLineOpened,
    ),
    handler(
      robinhood.logTrigger(logTriggerConfig({ addresses: [config.robinhood.address], topics: [[TOPIC.creditLineClosed]], confidence: config.confidence })),
      onCreditLineClosed,
    ),
    handler(
      arc.logTrigger(logTriggerConfig({ addresses: [config.arc.address], topics: [[TOPIC.drawn, TOPIC.repaid, TOPIC.creditLineFrozen]], confidence: config.confidence })),
      onArcActivity,
    ),
    handler(
      new HTTPCapability().trigger({
        authorizedKeys: (config.humanStarter?.authorizedKeys ?? []).map((publicKey) => ({ type: "KEY_TYPE_ECDSA_EVM" as const, publicKey })),
      }),
      onHumanStarter,
    ),
  ];
};

export async function main() {
  const runner = await Runner.newRunner<Config>();
  await runner.run(initWorkflow);
}
