// Records the Arc Studio app URL and Studio-reported deployments from an `arc-studio run --output json`
// result into arc-studio/studio.json. Studio's prose (finalText) is not copied: it is untrusted.
// Deployment addresses are Studio-reported until `pnpm exec tsx arc-studio/adopt.ts` verifies them on-chain.
import { readFileSync, writeFileSync } from 'node:fs';

const file = process.argv[2];
if (!file) throw new Error('usage: node arc-studio/record.mjs <result.json>');
let result;
try { result = JSON.parse(readFileSync(file, 'utf8')); }
catch { console.error(`No JSON result in ${file}; see run.stderr.log next to it`); process.exit(1); }
const isAddress = v => typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v);
const isHash = v => typeof v === 'string' && /^0x[0-9a-fA-F]{64}$/.test(v);
const record = {
  recordedAt: new Date().toISOString(),
  status: result.status,
  appId: result.appId ?? null,
  webUrl: typeof result.webUrl === 'string' && result.webUrl.startsWith('https://') ? result.webUrl : null,
  deployments: (result.deployments ?? []).filter(d => isAddress(d.address)).map(d => ({
    contract: String(d.contract), address: d.address, network: String(d.network ?? ''), txHash: isHash(d.txHash) ? d.txHash : null,
  })),
  filesChanged: (result.filesChanged ?? []).map(String),
  verifiedOnChain: false,
};
writeFileSync('arc-studio/studio.json', JSON.stringify(record, null, 2) + '\n');
console.log(`status ${record.status}; Studio URL: ${record.webUrl ?? '(none returned)'}`);
for (const d of record.deployments) console.log(`  ${d.contract.padEnd(20)} ${d.address}  (Studio-reported, unverified)`);
if (result.status === 'needs_input') console.log('Studio asked a question: read result.json "questions" and answer with arc-studio run --session noren --answers-json ...');
