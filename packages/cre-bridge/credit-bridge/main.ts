// Noren credit bridge: a Chainlink CRE workflow that carries the Noren credit line between
// Robinhood Chain and Arc. CRE carries messages only; no tokens cross chains.
//
//   handler 0  Robinhood  NorenCredit.CreditLineOpened  -> Arc        NorenCreditLine.onReport(borrower, lineId, limit, expiry)
//   handler 1  Robinhood  NorenCredit.CreditLineClosed  -> Arc        NorenCreditLine.onReport(borrower, lineId, 0, expiry)
//   handler 2  Arc        NorenCreditLine.Drawn/Repaid  -> Robinhood  NorenCredit.onReport(lineId, drawn, repaid, asOf)
//
// Each write is a DON-signed report delivered through the chain's CRE forwarder; the receivers
// accept onReport only from that forwarder.
import {
  bytesToHex,
  EVMClient,
  encodeCallMsg,
  getNetwork,
  handler,
  LATEST_BLOCK_NUMBER,
  logTriggerConfig,
  prepareReportRequest,
  protoBigIntToBigint,
  blockNumber as toBlockNumber,
  Runner,
  TxStatus,
  type EVMLog,
  type Runtime,
} from "@chainlink/cre-sdk";
import { decodeFunctionResult, encodeFunctionData, zeroAddress, type Address, type Hex } from "viem";
import {
  creditLineAbi,
  decideClose,
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

// ---------------------------------------------------------------- handler 2: Arc -> Robinhood (utilisation)

export const onArcActivity = (runtime: Runtime<Config>, log: EVMLog): string => {
  const config = runtime.config;
  validateConfig(config);
  const act = decodeArcActivity(rawLog(log), config.arc.address);
  runtime.log(
    `${act.kind} on ${config.arc.chainSelectorName} (${describeLog(log)}): line ${act.lineId} ${formatUsdc(act.amount)} USDC${act.merchant ? ` to merchant ${act.merchant} invoice ${act.invoiceId}` : ""}`,
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
  let robinhoodAsOf: bigint;
  if ((config.robinhood.receiver ?? "NorenCredit") === "NorenCredit") {
    const data = read(runtime, robinhood, config.robinhood.address, encodeFunctionData({ abi: robinhoodLineAbi, functionName: "line", args: [act.lineId] }), LATEST_BLOCK_NUMBER);
    if (data === "0x") throw new Error(`NorenCredit not found at ${config.robinhood.address} on ${config.robinhood.chainSelectorName}`);
    const l = decodeFunctionResult({ abi: robinhoodLineAbi, functionName: "line", data });
    if (l.borrower === zeroAddress) throw new Error(`line ${act.lineId} is unknown to NorenCredit`);
    robinhoodAsOf = l.asOf;
    runtime.log(`NorenCredit line: status ${LINE_STATUS[l.status] ?? l.status}, drawn ${formatUsdc(l.drawn)} repaid ${formatUsdc(l.repaid)} asOf ${l.asOf}`);
  } else {
    const data = read(runtime, robinhood, config.robinhood.address, encodeFunctionData({ abi: harnessUtilisationAbi, functionName: "utilisation", args: [act.lineId] }), LATEST_BLOCK_NUMBER);
    if (data === "0x") throw new Error(`NorenCreditHarness not found at ${config.robinhood.address}`);
    robinhoodAsOf = decodeFunctionResult({ abi: harnessUtilisationAbi, functionName: "utilisation", data })[2];
    runtime.log(`NorenCreditHarness (test harness) last asOf: ${robinhoodAsOf}`);
  }
  const decision = decideUtilisation(act.lineId, snapshot, robinhoodAsOf);
  return deliver(runtime, robinhood, config.robinhood, decision, "NorenCredit");
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
      arc.logTrigger(logTriggerConfig({ addresses: [config.arc.address], topics: [[TOPIC.drawn, TOPIC.repaid]], confidence: config.confidence })),
      onArcActivity,
    ),
  ];
};

export async function main() {
  const runner = await Runner.newRunner<Config>();
  await runner.run(initWorkflow);
}
