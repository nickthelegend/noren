// Noren cross-chain Aqua: a Chainlink CRE workflow that carries orders and fills between source
// chains (Robinhood Chain, Base Sepolia, ...) and Arc, where the 1inch Aqua makers live.
//
//   trigger i  log trigger on chains[i]: XChainMessage from its NorenCrossChainEscrow or NorenCrossChainSettler
//     ORDER    (escrow -> Arc settler)   checks the order, re-reads the Chainlink round at the log's
//                                         block, skips stale prices, filled/expired orders and passed deadlines
//     FILLED / EXPIRED (settler -> escrow) checks the escrow still holds the order Open
//   then signs the payload with the DON and writes it to the receiver through that chain's forwarder.
//
// The payload is delivered byte for byte: the contracts define the messages (XChainMessages.sol),
// so the same bytes could travel over CCIP or a CCTP hook instead.
import {
  bytesToHex,
  CronCapability,
  EVMClient,
  LAST_FINALIZED_BLOCK_NUMBER,
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
import { decodeFunctionResult, encodeFunctionData, parseAbi, zeroAddress, type Address, type Hex } from "viem";
import {
  actionRouterAbi,
  decidePrice,
  decideRouterOrder,
  decodeRouterOrderLog,
  relayedFeedAbi,
  TOPIC_AQUA_ORDER_OPENED,
  decideOrder,
  decideSettlement,
  decodeMessageLog,
  decodeOrderPayload,
  escrowAbi,
  feedAbi,
  KIND,
  payloadKind,
  routeMessage,
  settlerAbi,
  TOPIC_XCHAIN_MESSAGE,
  validateConfig,
  type ChainConfig,
  type Decision,
  type XChainConfig,
} from "./xchain";

export type Config = XChainConfig;

const decimalsAbi = parseAbi(["function decimals() view returns (uint8)"]);

const evmFor = (c: ChainConfig): EVMClient => {
  const network = getNetwork({ chainFamily: "evm", chainSelectorName: c.chainSelectorName, isTestnet: true });
  if (!network) throw new Error(`unknown CRE chain ${c.chainSelectorName}`);
  return new EVMClient(network.chainSelector.selector);
};

type ReadAt = typeof LATEST_BLOCK_NUMBER | ReturnType<typeof toBlockNumber>;

const read = (runtime: Runtime<Config>, evm: EVMClient, to: Address, data: Hex, at: ReadAt): Hex => {
  const reply = evm.callContract(runtime, { call: encodeCallMsg({ from: zeroAddress, to, data }), blockNumber: at }).result();
  return bytesToHex(reply.data);
};

const readStatus = (runtime: Runtime<Config>, evm: EVMClient, contract: Address, id: Hex, what: string): number => {
  const abi = what === "settler" ? settlerAbi : escrowAbi;
  const data = read(runtime, evm, contract, encodeFunctionData({ abi, functionName: "orderStatus", args: [id] }), LATEST_BLOCK_NUMBER);
  if (data === "0x") throw new Error(`no ${what} at ${contract}`);
  return Number(decodeFunctionResult({ abi, functionName: "orderStatus", data }));
};

const deliver = (runtime: Runtime<Config>, decision: Decision): string => {
  if (!decision.write) {
    runtime.log(`No write: ${decision.reason}`);
    return JSON.stringify({ status: "skipped", reason: decision.reason });
  }
  const { target, receiver, report: payload, summary } = decision.delivery;
  runtime.log(`Report: ${summary}`);
  const evm = evmFor(target);
  const report = runtime.report(prepareReportRequest(payload)).result();
  const reply = evm.writeReport(runtime, { receiver, report, gasConfig: { gasLimit: target.gasLimit } }).result();
  const txHash = reply.txHash && reply.txHash.length > 0 ? bytesToHex(reply.txHash) : null;
  if (reply.txStatus !== TxStatus.SUCCESS) {
    throw new Error(`writeReport to ${receiver} on ${target.name} failed: status ${TxStatus[reply.txStatus]} tx ${txHash} ${reply.errorMessage ?? ""}`);
  }
  // ReceiverContractExecutionStatus.REVERTED = 1: the forwarder tx landed but onReport reverted.
  if (reply.receiverContractExecutionStatus === 1) throw new Error(`onReport reverted on ${target.name} inside the forwarder call (tx ${txHash})`);
  if (!txHash) {
    runtime.log(`Report signed for ${target.name}; not broadcast, nothing sent`);
    return JSON.stringify({ status: "not-broadcast", receiver, payload });
  }
  runtime.log(`Delivered to ${target.name} ${receiver}: tx ${txHash}`);
  return JSON.stringify({ status: "written", chain: target.name, receiver, txHash });
};

export const onMessage = (source: ChainConfig) => (runtime: Runtime<Config>, log: EVMLog): string => {
  const config = runtime.config;
  validateConfig(config);
  if (bytesToHex(log.topics[0]).toLowerCase() === TOPIC_AQUA_ORDER_OPENED) return onRouterOrder(runtime, source, log);
  const msg = decodeMessageLog({ address: bytesToHex(log.address), topics: log.topics.map((t) => bytesToHex(t)), data: bytesToHex(log.data) });
  const block = log.blockNumber ? protoBigIntToBigint(log.blockNumber) : null;
  runtime.log(`XChainMessage on ${source.name} (tx ${bytesToHex(log.txHash)} log ${log.index}${block ? ` block ${block}` : ""}): order ${msg.orderId} kind ${payloadKind(msg.payload)} to ${msg.to} on chain ${msg.toChainId}`);
  const { target } = routeMessage(config, source, msg);
  const now = BigInt(Math.floor(runtime.now().getTime() / 1000));
  const kind = payloadKind(msg.payload);

  if (kind === KIND.ORDER) {
    const { price } = decodeOrderPayload(msg.payload);
    let roundAtBlock: { roundId: bigint; updatedAt: bigint } | null = null;
    if (price.updatedAt !== 0n) {
      if (!block) throw new Error("log has no block number; cannot re-read the Chainlink round at its block");
      const data = read(runtime, evmFor(source), price.sourceFeed, encodeFunctionData({ abi: feedAbi, functionName: "latestRoundData" }), toBlockNumber(block));
      const r = decodeFunctionResult({ abi: feedAbi, functionName: "latestRoundData", data });
      roundAtBlock = { roundId: r[0], updatedAt: r[3] };
      runtime.log(`Chainlink ${price.sourceFeed} on ${source.name} at block ${block}: round ${r[0]} answer ${r[1]} updatedAt ${r[3]} (${now - r[3]}s old)`);
    }
    const settlerStatus = readStatus(runtime, evmFor(target), target.settler, msg.orderId, "settler");
    return deliver(runtime, decideOrder(config, source, target, msg, { settlerStatus, roundAtBlock, nowSeconds: now }));
  }
  if (kind === KIND.FILLED || kind === KIND.EXPIRED) {
    const escrowStatus = readStatus(runtime, evmFor(target), target.escrow, msg.orderId, "escrow");
    return deliver(runtime, decideSettlement(source, target, msg, escrowStatus));
  }
  throw new Error(`unexpected payload kind ${kind}`);
};

/** AQUA_ORDER held by the Arc action router (CCTP/CCIP arrival): ask the settler to fill it. */
const onRouterOrder = (runtime: Runtime<Config>, arc: ChainConfig, log: EVMLog): string => {
  const ev = decodeRouterOrderLog({ address: bytesToHex(log.address), topics: log.topics.map((t) => bytesToHex(t)), data: bytesToHex(log.data) });
  runtime.log(`AquaOrderOpened on ${arc.name} (tx ${bytesToHex(log.txHash)} log ${log.index}): ref ${ev.ref} beneficiary ${ev.beneficiary} ${ev.amount} of ${ev.token} from source ${ev.source}`);
  const data = read(runtime, evmFor(arc), ev.router, encodeFunctionData({ abi: actionRouterAbi, functionName: "aquaOrders", args: [ev.ref] }), LATEST_BLOCK_NUMBER);
  const o = decodeFunctionResult({ abi: actionRouterAbi, functionName: "aquaOrders", data });
  return deliver(runtime, decideRouterOrder(arc, ev.router, ev.ref, o[5], `ROUTER_ORDER ${ev.ref}: fill ${ev.amount} of ${ev.token} for ${ev.beneficiary} through the maker's strategy`));
};

/** Cron: relay each configured Chainlink round (read at the last finalized block) to its NorenRelayedFeed on Arc. */
export const onPriceCron = (runtime: Runtime<Config>): string => {
  const config = runtime.config;
  validateConfig(config);
  const arc = config.chains.find((c) => c.settler !== zeroAddress);
  if (!arc) throw new Error("Setup required: no settler chain");
  const now = BigInt(Math.floor(runtime.now().getTime() / 1000));
  const results: string[] = [];
  for (const relay of config.prices ?? []) {
    const src = evmFor({ name: relay.name, chainSelectorName: relay.chainSelectorName, chainId: 1, escrow: zeroAddress, settler: zeroAddress, gasLimit: "0" });
    const rd = read(runtime, src, relay.feed, encodeFunctionData({ abi: feedAbi, functionName: "latestRoundData" }), LAST_FINALIZED_BLOCK_NUMBER);
    const r = decodeFunctionResult({ abi: feedAbi, functionName: "latestRoundData", data: rd });
    const dd = read(runtime, src, relay.feed, encodeFunctionData({ abi: decimalsAbi, functionName: "decimals" }), LAST_FINALIZED_BLOCK_NUMBER);
    const decimals = Number(decodeFunctionResult({ abi: decimalsAbi, functionName: "decimals", data: dd }));
    const arcEvm = evmFor(arc);
    const lr = read(runtime, arcEvm, relay.relayedFeed, encodeFunctionData({ abi: relayedFeedAbi, functionName: "latestRound" }), LATEST_BLOCK_NUMBER);
    const relayed = decodeFunctionResult({ abi: relayedFeedAbi, functionName: "latestRound", data: lr });
    const sf = read(runtime, arcEvm, relay.relayedFeed, encodeFunctionData({ abi: relayedFeedAbi, functionName: "sourceFeed" }), LATEST_BLOCK_NUMBER);
    const relayedSource = decodeFunctionResult({ abi: relayedFeedAbi, functionName: "sourceFeed", data: sf });
    runtime.log(`Chainlink ${relay.name} ${relay.feed} on ${relay.chainSelectorName} (finalized): round ${r[0]} answer ${r[1]} updatedAt ${r[3]}; relayed round ${relayed.roundId}`);
    const source = { roundId: r[0], answer: r[1], startedAt: r[2], updatedAt: r[3], answeredInRound: r[4] };
    results.push(deliver(runtime, decidePrice(arc, relay, source, decimals, relayed, relayedSource, now, config.maxPriceAgeSec)));
  }
  return `[${results.join(",")}]`;
};

export const initWorkflow = (config: Config) => {
  validateConfig(config);
  const logHandlers = config.chains.map((c) =>
    handler(
      evmFor(c).logTrigger(
        logTriggerConfig({
          addresses: [c.escrow, c.settler, c.actionRouter ?? zeroAddress].filter((a) => a !== zeroAddress) as Address[],
          topics: [c.actionRouter ? [TOPIC_XCHAIN_MESSAGE, TOPIC_AQUA_ORDER_OPENED] : [TOPIC_XCHAIN_MESSAGE]],
          confidence: config.confidence,
        }),
      ),
      onMessage(c),
    ),
  );
  const cron = (config.prices ?? []).length > 0 ? [handler(new CronCapability().trigger({ schedule: config.schedule! }), onPriceCron)] : [];
  return [...logHandlers, ...cron];
};

export async function main() {
  const runner = await Runner.newRunner<Config>();
  await runner.run(initWorkflow);
}
