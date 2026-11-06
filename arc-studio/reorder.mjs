// `forge flatten` emits Privacy Pools' `interface IState` after `interface IPrivacyPool is IState`
// (their imports are circular), and solc rejects a base defined after its derived contract (error 2449).
// This moves the IState block, unchanged, to just before IPrivacyPool. Nothing else in the file changes.
import { readFileSync, writeFileSync } from 'node:fs';

for (const file of process.argv.slice(2)) {
  const src = readFileSync(file, 'utf8');
  const derived = src.indexOf('interface IPrivacyPool is IState');
  const start = src.indexOf('interface IState {');
  if (derived === -1 || start === -1 || start < derived) continue; // already in order
  let depth = 0, end = -1;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) { end = i + 1; break; }
  }
  if (end === -1) throw new Error(`${file}: unbalanced braces in IState`);
  const block = src.slice(start, end);
  const without = src.slice(0, start) + src.slice(end);
  writeFileSync(file, without.slice(0, derived) + block + '\n\n' + without.slice(derived));
  console.log(`reordered IState before IPrivacyPool in ${file.split('/').pop()}`);
}
