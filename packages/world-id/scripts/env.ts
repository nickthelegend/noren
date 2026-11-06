// Loads the gitignored .env for the World ID scripts without printing anything from it.
// Order: $NOREN_ENV_FILE, this checkout's .env, then the main checkout's .env (so a git worktree
// shares the one file Nick fills in). Variables already set in the shell win.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const candidates = [process.env.NOREN_ENV_FILE, resolve(repo, '.env')];
try { candidates.push(resolve(dirname(execFileSync('git', ['-C', repo, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' }).trim()), '.env')); } catch { /* not a git checkout */ }
export const envFile = candidates.find(f => f && existsSync(f));
if (envFile) process.loadEnvFile(envFile);
