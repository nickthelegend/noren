// Noren settlement desk: a Chainlink CRE workflow that approves moving a merchant's USDG on
// Robinhood Chain to USDC on Arc, only at a fair price.
//
//   trigger   NorenSettlementDesk.SettlementRequested (Robinhood, EVM log trigger)
//   HTTP      live Relay quote (POST /quote) and Across quote (GET /api/suggested-fees), DON consensus
//   HTTP      Chainlink USDG/USD on Robinhood mainnet and USDC/USD on Arc mainnet, read as JSON-RPC
//             eth_call at a median-agreed block, byte-identical across nodes
//   decide    fair = amount x USDG/USD / USDC/USD; approve the better quote within max slippage
//   write     approve/reject report -> CRE forwarder -> NorenSettlementDesk.onReport
//
// The desk then lets a keeper execute the deposit into the real Relay Depository or Across
// SpokePool, re-checking the calldata on-chain. The Arc-side fill is done by the bridge's relayer.
import {
  bytesToHex,
  ConsensusAggregationByFields,
  EVMClient,
  encodeCallMsg,
  getNetwork,
  handler,
  hexToBase64,
  HTTPClient,
  identical,
  json,
  LATEST_BLOCK_NUMBER,
  logTriggerConfig,
  median,
  prepareReportRequest,
  Runner,
  TxStatus,
  type EVMLog,
  type HTTPSendRequester,
  type Runtime,
} from "@chainlink/cre-sdk";
import { decodeFunctionResult, encodeFunctionData, stringToHex, zeroAddress, type Address, type Hex } from "viem";
import {
  acrossFeesUrl,
  checkStableFeed,
  decide,
  decodeRequested,
  decodeRound,
  deskAbi,
  encodeReport,
  headRequest,
  parseAcrossFees,
  parseHead,
  parseRelayQuote,
  parseRound,
  relayQuoteBody,
  roundRequest,
  SETTLEMENT_REQUESTED,
  STATUS_REQUESTED,
  validateConfig,
  type Config,
  type JsonRpcCall,
  type Request,
  type RouteQuote,
} from "./settle";

export type { Config };

const send = (sr: HTTPSendRequester, url: string, method: "GET" | "POST", body?: unknown): { status: number; json: unknown } => {
  const response = sr
    .sendRequest({
      url,
      method,
      multiHeaders: { "Content-Type": { values: ["application/json"] }, Accept: { values: ["application/json"] } },
      ...(body === undefined ? {} : { body: hexToBase64(stringToHex(JSON.stringify(body))) }),
    })
    .result();
  let parsed: unknown = null;
  try {
    parsed = json(response);
  } catch {
    parsed = null;
  }
  return { status: response.statusCode, json: parsed };
};

type QuoteFields = { ok: boolean; outUsdc6: bigint; seconds: bigint; reason: string };

const relayQuote = (sr: HTTPSendRequester, c: Config, r: Request): QuoteFields => {
  const res = send(sr, c.relay.quoteUrl, "POST", relayQuoteBody(c, r));
  if (res.status !== 200) {
    const msg = (res.json as { message?: string } | null)?.message ?? "";
    return { ok: false, outUsdc6: 0n, seconds: 0n, reason: `relay HTTP ${res.status} ${msg}`.trim() };
  }
  return parseRelayQuote(c, r, res.json);
};

const acrossQuote = (sr: HTTPSendRequester, c: Config, r: Request): QuoteFields => {
  const res = send(sr, acrossFeesUrl(c, r), "GET");
  if (res.status !== 200) {
    const msg = (res.json as { message?: string } | null)?.message ?? "";
    return { ok: false, outUsdc6: 0n, seconds: 0n, reason: `across HTTP ${res.status} ${msg}`.trim() };
  }
  return parseAcrossFees(c, r, res.json);
};

const rpc = (sr: HTTPSendRequester, url: string, calls: JsonRpcCall[]): unknown => {
  const res = send(sr, url, "POST", calls);
  if (res.status !== 200) throw new Error(`JSON-RPC ${url} returned HTTP ${res.status}`);
  return res.json;
};

/** Live quote with consensus: ok and reason must match on every node; amounts and time by median. */
const quoteConsensus = ConsensusAggregationByFields<QuoteFields>({ ok: identical, reason: identical, outUsdc6: median, seconds: median });

/** Chainlink feed over JSON-RPC: chain id identical, block median, then the round read at that block must be identical. */
const readFeed = (runtime: Runtime<Config>, http: HTTPClient, url: string, chainId: number, feed: Address, name: string) => {
  const c = runtime.config;
  const head = http
    .sendRequest(runtime, (sr: HTTPSendRequester) => parseHead(rpc(sr, url, headRequest())), ConsensusAggregationByFields<{ chainId: number; blockNumber: number }>({ chainId: identical, blockNumber: median }))()
    .result();
  if (head.chainId !== chainId) throw new Error(`${name} RPC is chain ${head.chainId}, expected ${chainId}`);
  const block = head.blockNumber - c.feeds.blockLag;
  const round = http
    .sendRequest(runtime, (sr: HTTPSendRequester) => parseRound(rpc(sr, url, roundRequest(feed, block))), ConsensusAggregationByFields<{ raw: Hex; blockTime: number }>({ raw: identical, blockTime: identical }))()
    .result();
  const decoded = decodeRound(round.raw);
  const price8 = checkStableFeed(name, decoded, round.blockTime, c);
  runtime.log(`${name} (Chainlink ${feed} on chain ${chainId} at block ${block}): ${price8} (8 dp), round ${decoded.roundId}, updated ${decoded.updatedAt}`);
  return price8;
};

export const onSettlementRequested = (runtime: Runtime<Config>, log: EVMLog): string => {
  const c = runtime.config;
  validateConfig(c);
  const r = decodeRequested({ address: bytesToHex(log.address), topics: log.topics.map((t) => bytesToHex(t)), data: bytesToHex(log.data) }, c.desk.address);
  runtime.log(`SettlementRequested ${r.id}: ${r.amountUsdg6} USDG6 from ${r.merchant} to ${r.arcRecipient} on Arc, max slippage ${r.maxSlippageBps} bps (tx ${bytesToHex(log.txHash)})`);

  const network = getNetwork({ chainFamily: "evm", chainSelectorName: c.desk.chainSelectorName, isTestnet: true });
  if (!network) throw new Error(`unknown CRE chain ${c.desk.chainSelectorName}`);
  const evm = new EVMClient(network.chainSelector.selector);
  const stateData = bytesToHex(
    evm
      .callContract(runtime, {
        call: encodeCallMsg({ from: zeroAddress, to: c.desk.address, data: encodeFunctionData({ abi: deskAbi, functionName: "settlement", args: [r.id] }) }),
        blockNumber: LATEST_BLOCK_NUMBER,
      })
      .result().data,
  );
  if (stateData === "0x") throw new Error(`NorenSettlementDesk not found at ${c.desk.address}`);
  const state = decodeFunctionResult({ abi: deskAbi, functionName: "settlement", data: stateData });
  if (state.status !== STATUS_REQUESTED) {
    runtime.log(`No write: settlement ${r.id} has status ${state.status}, not Requested`);
    return JSON.stringify({ status: "skipped", id: r.id, deskStatus: state.status });
  }

  const http = new HTTPClient();
  const relay: RouteQuote = http.sendRequest(runtime, relayQuote, quoteConsensus)(c, r).result();
  const across: RouteQuote = http.sendRequest(runtime, acrossQuote, quoteConsensus)(c, r).result();
  runtime.log(`Relay quote: ${relay.ok ? `${relay.outUsdc6} USDC6 on Arc, ~${relay.seconds}s` : relay.reason}`);
  runtime.log(`Across quote: ${across.ok ? `${across.outUsdc6} USDC6 on Arc, ~${across.seconds}s` : across.reason}`);

  const usdgUsd8 = readFeed(runtime, http, c.feeds.robinhoodRpcUrl, c.originChainId, c.feeds.usdgUsd, "USDG/USD");
  const usdcUsd8 = readFeed(runtime, http, c.feeds.arcRpcUrl, c.destinationChainId, c.feeds.usdcUsd, "USDC/USD");

  const d = decide(r, relay, across, usdgUsd8, usdcUsd8);
  runtime.log(`Decision: ${d.summary}`);
  const nowSeconds = BigInt(Math.floor(runtime.now().getTime() / 1000));
  const validUntil = d.kind === 1 ? nowSeconds + BigInt(c.approvalTtlSeconds) : 0n;
  const reportHex = encodeReport(d, r.id, usdgUsd8, usdcUsd8, validUntil);

  const report = runtime.report(prepareReportRequest(reportHex)).result();
  const reply = evm.writeReport(runtime, { receiver: c.desk.address, report, gasConfig: { gasLimit: c.desk.gasLimit } }).result();
  const txHash = reply.txHash && reply.txHash.length > 0 ? bytesToHex(reply.txHash) : null;
  if (reply.txStatus !== TxStatus.SUCCESS) throw new Error(`writeReport failed: status ${TxStatus[reply.txStatus]} tx ${txHash} ${reply.errorMessage ?? ""}`);
  if (reply.receiverContractExecutionStatus === 1) throw new Error(`NorenSettlementDesk.onReport reverted inside the forwarder call (tx ${txHash})`);
  const result = { status: txHash ? "written" : "not-broadcast", decision: d.kind === 1 ? "approve" : "reject", route: d.route, id: r.id,
    fairOutUsdc6: d.fairOutUsdc6.toString(), minOutUsdc6: d.minOutUsdc6.toString(), quotedOutUsdc6: d.quotedOutUsdc6.toString(),
    relayOutUsdc6: relay.outUsdc6.toString(), acrossOutUsdc6: across.outUsdc6.toString(), usdgUsd8: usdgUsd8.toString(), usdcUsd8: usdcUsd8.toString(),
    validUntil: validUntil.toString(), txHash };
  runtime.log(txHash ? `NorenSettlementDesk updated on ${c.desk.chainSelectorName}: tx ${txHash}` : "Report signed; not broadcast, nothing sent");
  return JSON.stringify(result);
};

export const initWorkflow = (config: Config) => {
  validateConfig(config);
  const network = getNetwork({ chainFamily: "evm", chainSelectorName: config.desk.chainSelectorName, isTestnet: true });
  if (!network) throw new Error(`unknown CRE chain ${config.desk.chainSelectorName}`);
  const evm = new EVMClient(network.chainSelector.selector);
  return [
    handler(
      evm.logTrigger(logTriggerConfig({ addresses: [config.desk.address], topics: [[SETTLEMENT_REQUESTED]], confidence: config.confidence })),
      onSettlementRequested,
    ),
  ];
};

export async function main() {
  const runner = await Runner.newRunner<Config>();
  await runner.run(initWorkflow);
}
