// `pnpm dev:stack`: Arc testnet fork + Noren contracts + ASP postman + merchant server. Ctrl-C stops everything.
import { run, startStack } from './stack.ts';
run(() => startStack());
