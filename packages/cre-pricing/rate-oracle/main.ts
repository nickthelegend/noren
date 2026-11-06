// Noren rate oracle: a CRE workflow that reads Chainlink fiat/USD and USDC/USD Data Feeds
// on Arc mainnet and writes the rates, with both round IDs, to NorenRateOracle on Arc Testnet.
//
// Arc mainnet is not a CRE EVM target, so the feeds are read through the CRE HTTP capability
// as JSON-RPC eth_call batches. Each DON node makes the same request; the block number is agreed
// by median, then every node reads the feeds at that one block and the raw results must be identical.
import {
  bytesToHex,
  ConsensusAggregationByFields,
  CronCapability,
  EVMClient,
  encodeCallMsg,
  getNetwork,
  handler,
  hexToBase64,
  HTTPClient,
  identical,
  json,
  LATEST_BLOCK_NUMBER,
  median,
  ok,
  prepareReportRequest,
  Runner,
  TxStatus,
  type HTTPSendRequester,
  type Runtime,
} from "@chainlink/cre-sdk";
import { decodeFunctionResult, encodeFunctionData, parseAbi, stringToHex, zeroAddress, type Address, type Hex } from "viem";
import {
  buildUpdates,
  decodeRounds,
  encodeReport,
  formatRate,
  headRequest,
  parseHead,
  parseRounds,
  roundsRequest,
  validateConfig,
  type JsonRpcCall,
  type PricingConfig,
} from "./rates";

export type Config = PricingConfig & {
  schedule: string;
  /** Read-only Arc mainnet JSON-RPC endpoint (no key). */
  priceRpcUrl: string;
  /** Blocks to stay behind the agreed finalized head, so every node's RPC has the block. */
  blockLag: number;
  oracle: {
    chainSelectorName: string;
    address: Address;
    gasLimit: string;
  };
};

const oracleAbi = parseAbi([
  "function roundsFor(string[] currencies) view returns (uint80[] fiatRoundIds, uint80[] usdcRoundIds)",
]);

const postJson = (sendRequester: HTTPSendRequester, url: string, body: JsonRpcCall[]): unknown => {
  const response = sendRequester
    .sendRequest({
      url,
      method: "POST",
      multiHeaders: { "Content-Type": { values: ["application/json"] } },
      body: hexToBase64(stringToHex(JSON.stringify(body))),
    })
    .result();
  if (!ok(response)) throw new Error(`Arc mainnet RPC ${url} returned HTTP ${response.statusCode}`);
  return json(response);
};

const fetchHead = (sendRequester: HTTPSendRequester, url: string) => parseHead(postJson(sendRequester, url, headRequest()));

const fetchRounds = (sendRequester: HTTPSendRequester, config: Config, blockNumber: number) => ({
  results: parseRounds(config, postJson(sendRequester, config.priceRpcUrl, roundsRequest(config, blockNumber))).join(","),
});

export const onCronTrigger = (runtime: Runtime<Config>): string => {
  const config = runtime.config;
  validateConfig(config);
  if (!config.oracle.address || config.oracle.address === zeroAddress) {
    throw new Error("Setup required: config.oracle.address (deploy NorenRateOracle on Arc Testnet first)");
  }
  const http = new HTTPClient();

  // 1. Agree on the source block: chain ID must be identical, block number is the median.
  const head = http
    .sendRequest(
      runtime,
      fetchHead,
      ConsensusAggregationByFields<{ chainId: number; blockNumber: number }>({ chainId: identical, blockNumber: median }),
    )(config.priceRpcUrl)
    .result();
  if (head.chainId !== config.sourceChainId) throw new Error(`price RPC is chain ${head.chainId}, expected Arc mainnet ${config.sourceChainId}`);
  const sourceBlock = head.blockNumber - config.blockLag;
  runtime.log(`Arc mainnet finalized block ${head.blockNumber}; reading feeds at ${sourceBlock}`);

  // 2. Read every feed at that block. All nodes must return byte-identical eth_call results.
  const rounds = http
    .sendRequest(runtime, fetchRounds, ConsensusAggregationByFields<{ results: string }>({ results: identical }))(config, sourceBlock)
    .result();
  const points = decodeRounds(config, rounds.results.split(","));

  // 3. Validate (positive, complete, fresh) and build the report with DON time.
  const nowSeconds = BigInt(Math.floor(runtime.now().getTime() / 1000));
  const updates = buildUpdates(config, points, nowSeconds);
  for (const u of updates) {
    runtime.log(
      `${u.currency}: 1 ${u.currency} = ${formatRate(u.rateE18)} USDC (fiat round ${u.fiatUsdRoundId} @ ${u.fiatUsdUpdatedAt}, USDC round ${u.usdcUsdRoundId} @ ${u.usdcUsdUpdatedAt})`,
    );
  }

  // 4. Read the oracle on Arc Testnet; skip the write when every round pair is already stored.
  const network = getNetwork({ chainFamily: "evm", chainSelectorName: config.oracle.chainSelectorName, isTestnet: true });
  if (!network) throw new Error(`unknown CRE chain ${config.oracle.chainSelectorName}`);
  const evm = new EVMClient(network.chainSelector.selector);
  const stored = evm
    .callContract(runtime, {
      call: encodeCallMsg({
        from: zeroAddress,
        to: config.oracle.address,
        data: encodeFunctionData({ abi: oracleAbi, functionName: "roundsFor", args: [updates.map((u) => u.currency)] }),
      }),
      blockNumber: LATEST_BLOCK_NUMBER,
    })
    .result();
  if (stored.data.length === 0) throw new Error(`NorenRateOracle not found at ${config.oracle.address} on ${config.oracle.chainSelectorName}`);
  const [storedFiat, storedUsdc] = decodeFunctionResult({ abi: oracleAbi, functionName: "roundsFor", data: bytesToHex(stored.data) });
  const changed = updates.filter((u, i) => storedFiat[i] !== u.fiatUsdRoundId || storedUsdc[i] !== u.usdcUsdRoundId);
  if (changed.length === 0) {
    runtime.log(`All ${updates.length} rates already on-chain at these rounds; no write`);
    return JSON.stringify({ status: "unchanged", sourceBlock, currencies: updates.length });
  }

  // 5. Sign the report through the DON and deliver it to NorenRateOracle.onReport via the forwarder.
  const reportHex: Hex = encodeReport(config.sourceChainId, sourceBlock, config.usdcUsdFeed, updates);
  const report = runtime.report(prepareReportRequest(reportHex)).result();
  const reply = evm
    .writeReport(runtime, { receiver: config.oracle.address, report, gasConfig: { gasLimit: config.oracle.gasLimit } })
    .result();
  const txHash = reply.txHash ? bytesToHex(reply.txHash) : "none";
  if (reply.txStatus !== TxStatus.SUCCESS) {
    throw new Error(`writeReport failed: status ${TxStatus[reply.txStatus]} tx ${txHash} ${reply.errorMessage ?? ""}`);
  }
  // ReceiverContractExecutionStatus.REVERTED = 1: the forwarder tx succeeded but onReport reverted.
  if (reply.receiverContractExecutionStatus === 1) {
    throw new Error(`NorenRateOracle.onReport reverted inside the forwarder call (tx ${txHash})`);
  }
  runtime.log(`NorenRateOracle updated: ${changed.length} changed of ${updates.length}, tx ${txHash}`);
  return JSON.stringify({ status: "written", sourceBlock, currencies: updates.length, changed: changed.map((u) => u.currency), txHash });
};

export const initWorkflow = (config: Config) => {
  const cron = new CronCapability();
  return [handler(cron.trigger({ schedule: config.schedule }), onCronTrigger)];
};

export async function main() {
  const runner = await Runner.newRunner<Config>();
  await runner.run(initWorkflow);
}
