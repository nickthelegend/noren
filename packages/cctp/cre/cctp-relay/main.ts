// Noren CCTP relay: a Chainlink CRE workflow that brings USDC from other chains into Arc.
//
//   trigger  MessageTransmitterV2.MessageSent on each source testnet (EVM log trigger, one handler per chain)
//   filter   only CCTP V2 burns to Arc (domain 26) whose destinationCaller is NorenArcHook
//   HTTP     Circle Iris GET /v2/messages/{domain}?transactionHash=..., identical consensus on
//            state, message and attestation across DON nodes
//   check    the attested message is the logged burn (all fields but those Circle fills in)
//   read     NorenArcHook.processed(nonce) on Arc: skip a nonce that is already done
//   write    report abi.encode(message, attestation) -> CRE forwarder -> NorenArcHook.onReport on Arc,
//            which calls Circle's MessageTransmitterV2.receiveMessage (USDC minted on Arc) and runs the hook action
import {
  bytesToHex,
  ConsensusAggregationByFields,
  EVMClient,
  encodeCallMsg,
  getNetwork,
  handler,
  HTTPClient,
  identical,
  json,
  LATEST_BLOCK_NUMBER,
  logTriggerConfig,
  prepareReportRequest,
  Runner,
  TxStatus,
  type EVMLog,
  type HTTPSendRequester,
  type Runtime,
} from "@chainlink/cre-sdk";
import { decodeFunctionResult, encodeFunctionData, zeroAddress, type Hex } from "viem";
import { parseMessage } from "../../sdk/message";
import {
  decodeMessageSent,
  encodeReport,
  hookAbi,
  irisFields,
  irisUrl,
  MESSAGE_SENT,
  routeOf,
  sameBurn,
  validateConfig,
  type Config,
  type IrisFields,
  type SourceConfig,
} from "./relay";

export type { Config };

const evmFor = (chainSelectorName: string): EVMClient => {
  const network = getNetwork({ chainFamily: "evm", chainSelectorName, isTestnet: true });
  if (!network) throw new Error(`unknown CRE chain ${chainSelectorName}`);
  return new EVMClient(network.chainSelector.selector);
};

const fetchIris = (sr: HTTPSendRequester, url: string): IrisFields => {
  const response = sr.sendRequest({ url, method: "GET", multiHeaders: { Accept: { values: ["application/json"] } } }).result();
  let body: unknown = null;
  try {
    body = json(response);
  } catch {
    body = null;
  }
  return irisFields(response.statusCode, body);
};

const irisConsensus = ConsensusAggregationByFields<IrisFields>({ state: identical, message: identical, attestation: identical, detail: identical });

const onMessageSent = (source: SourceConfig) => (runtime: Runtime<Config>, log: EVMLog): string => {
  const c = runtime.config;
  const txHash = bytesToHex(log.txHash) as Hex;
  const logged = decodeMessageSent({ address: bytesToHex(log.address), topics: log.topics.map((t) => bytesToHex(t)), data: bytesToHex(log.data) }, c.messageTransmitter);
  const route = routeOf(logged, source, c.arc.hook);
  if (!route.relay) {
    runtime.log(`Skip ${source.key} tx ${txHash}: ${route.reason}`);
    return JSON.stringify({ status: "skipped", source: source.key, txHash, reason: route.reason });
  }
  const b = route.message.body;
  runtime.log(`Noren burn on ${source.key} (domain ${source.domain}) tx ${txHash}: ${b.amount} USDC6 to Arc, maxFee ${b.maxFee}, minFinality ${route.message.minFinalityThreshold}, hookData ${(b.hookData.length - 2) / 2} bytes`);

  const http = new HTTPClient();
  const iris = http.sendRequest(runtime, fetchIris, irisConsensus)(irisUrl(c, source.domain, txHash)).result();
  if (iris.state !== "complete") {
    runtime.log(`Circle attestation not ready (${iris.state}: ${iris.detail}); no write`);
    return JSON.stringify({ status: `attestation-${iris.state}`, source: source.key, txHash, detail: iris.detail });
  }
  const attested = parseMessage(iris.message as Hex);
  const mismatch = sameBurn(route.message, attested);
  if (mismatch) throw new Error(`Iris message does not match the logged burn: ${mismatch}`);
  runtime.log(`Circle attestation ready: nonce ${attested.nonce}, finality executed ${attested.finalityThresholdExecuted}, fee ${attested.body.feeExecuted}, ${(iris.attestation.length - 2) / 130} signature(s)`);

  const arc = evmFor(c.arc.chainSelectorName);
  const done = bytesToHex(
    arc.callContract(runtime, {
      call: encodeCallMsg({ from: zeroAddress, to: c.arc.hook, data: encodeFunctionData({ abi: hookAbi, functionName: "processed", args: [attested.nonce] }) }),
      blockNumber: LATEST_BLOCK_NUMBER,
    }).result().data,
  );
  if (done === "0x") throw new Error(`NorenArcHook not found at ${c.arc.hook} on ${c.arc.chainSelectorName}`);
  if (decodeFunctionResult({ abi: hookAbi, functionName: "processed", data: done })) {
    runtime.log(`No write: nonce ${attested.nonce} is already processed on Arc`);
    return JSON.stringify({ status: "already-minted", source: source.key, txHash, nonce: attested.nonce });
  }

  const report = runtime.report(prepareReportRequest(encodeReport(iris.message as Hex, iris.attestation as Hex))).result();
  const reply = arc.writeReport(runtime, { receiver: c.arc.hook, report, gasConfig: { gasLimit: c.arc.gasLimit } }).result();
  const writeTx = reply.txHash && reply.txHash.length > 0 ? bytesToHex(reply.txHash) : null;
  if (reply.txStatus !== TxStatus.SUCCESS) throw new Error(`writeReport failed: status ${TxStatus[reply.txStatus]} tx ${writeTx} ${reply.errorMessage ?? ""}`);
  if (reply.receiverContractExecutionStatus === 1) throw new Error(`NorenArcHook.onReport reverted inside the forwarder call (tx ${writeTx})`);
  runtime.log(writeTx ? `USDC minted on Arc through NorenArcHook: tx ${writeTx}` : "Report signed; not broadcast, nothing sent");
  return JSON.stringify({
    status: writeTx ? "minted" : "not-broadcast", source: source.key, burnTx: txHash, nonce: attested.nonce,
    amount: attested.body.amount.toString(), feeExecuted: attested.body.feeExecuted.toString(), minted: (attested.body.amount - attested.body.feeExecuted).toString(),
    finalityThresholdExecuted: attested.finalityThresholdExecuted, arcTx: writeTx,
  });
};

export const initWorkflow = (config: Config) => {
  validateConfig(config);
  return config.sources.map((source) =>
    handler(
      evmFor(source.chainSelectorName).logTrigger(logTriggerConfig({ addresses: [config.messageTransmitter], topics: [[MESSAGE_SENT]], confidence: config.confidence })),
      onMessageSent(source),
    ),
  );
};

export async function main() {
  const runner = await Runner.newRunner<Config>();
  await runner.run(initWorkflow);
}
