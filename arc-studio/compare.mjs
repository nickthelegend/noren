// Checks that each contract compiled from the flattened Studio bundle has exactly the same
// creation bytecode (library placeholders aside) as the repo's own forge build.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const [simOut, repoOut] = process.argv.slice(2);
const names = ['PoseidonT3', 'PoseidonT4', 'WithdrawalVerifier', 'CommitmentVerifier', 'Entrypoint', 'ERC1967Proxy', 'PrivacyPoolComplex', 'NorenCheckout', 'NorenQuoter', 'NorenRateOracle', 'NorenCreditLine'];
const strip = hex => hex.replace(/__\$[0-9a-f]{34}\$__/g, '_'.repeat(40));
let bad = 0;
for (const name of names) {
  let sim;
  try { sim = JSON.parse(readFileSync(join(simOut, `${name}.sol`, `${name}.json`), 'utf8')); } catch { continue; }
  const repoFile = [join(repoOut, `${name}.sol`, `${name}.json`)].find(f => { try { readFileSync(f); return true; } catch { return false; } });
  if (!repoFile) { console.log(`  ${name.padEnd(20)} compiled (no repo artifact to compare)`); continue; }
  const same = strip(sim.bytecode.object) === strip(JSON.parse(readFileSync(repoFile, 'utf8')).bytecode.object);
  const size = (sim.deployedBytecode.object.length - 2) / 2;
  console.log(`  ${name.padEnd(20)} ${String(size).padStart(6)} bytes  ${same ? 'bytecode identical to repo build' : 'BYTECODE DIFFERS'}`);
  if (!same) bad++;
}
if (bad) { console.error(`${bad} contract(s) differ from the repo build`); process.exit(1); }
