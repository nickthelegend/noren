// A small live harness for the World ID check, on http://127.0.0.1:8750
//   pnpm --filter @noren/world-id harness
// It mounts the same createWorldIdHandler the Noren server mounts, serves a one-page client that
// uses IDKit's browser build (idkit-core), and talks to the real World ID bridge and Developer Portal.
// With WORLD_ENVIRONMENT=staging, approve the request in the World ID Simulator
// (https://simulator.worldcoin.org) by pasting the connect link. Without the World settings every
// route answers "Setup required". Data: <repo>/data/world-id-harness.json (gitignored).
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import './env.ts';
import { build } from 'esbuild';
import { createWorldIdHandler, loadWorldIdConfig, starterSinkFromEnv, WorldIdService } from '../src/server.ts';

const here = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.NOREN_WORLD_HARNESS_PORT ?? 8750);
if (PORT < 8750 || PORT > 8759) throw new Error('NOREN_WORLD_HARNESS_PORT must be in 8750-8759');
const dataDir = process.env.NOREN_DATA_DIR ?? resolve(here, '../../../data');
const service = new WorldIdService({ config: loadWorldIdConfig(), dataFile: join(dataDir, 'world-id-harness.json'), sink: starterSinkFromEnv() });
const worldId = createWorldIdHandler(service);
let reactBundle: Promise<string> | undefined;
const REACT_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Noren · VerifyHuman</title>
<style>body{margin:0;background:#fbf8f1;color:#17203f;font:14px/1.5 system-ui,sans-serif}.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:40px;padding:0 16px;border-radius:10px;border:1px solid transparent;font-weight:700;font-size:14px;cursor:pointer}.btn.ink{background:#1c2a5e;color:#fbf8f1}.btn.line{background:#fffdf8;border-color:rgba(23,32,63,.18);color:#17203f}.btn:disabled{opacity:.5;cursor:not-allowed}</style>
</head><body><div id="root"></div><script type="module" src="/react.js"></script></body></html>`;
const idkitGlobal = join(dirname(fileURLToPath(import.meta.resolve('@worldcoin/idkit-core'))), 'idkit.global.js');

const server = createServer(async (req, res) => {
  try {
    if (await worldId(req, res)) return;
    const path = new URL(req.url ?? '/', 'http://local').pathname;
    if (req.method === 'GET' && (path === '/' || path === '/index.html')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(await readFile(join(here, '../harness/index.html')));
    }
    if (req.method === 'GET' && path === '/react') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(REACT_PAGE);
    }
    if (req.method === 'GET' && path === '/react.js') {
      reactBundle ??= build({ entryPoints: [join(here, '../harness/react-entry.tsx')], bundle: true, write: false, format: 'esm', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"development"' }, logLevel: 'silent' }).then(r => r.outputFiles[0].text);
      const js = await reactBundle.catch(e => { reactBundle = undefined; throw e; });
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
      return res.end(js);
    }
    if (req.method === 'GET' && path === '/idkit.js') {
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
      return res.end(await readFile(idkitGlobal));
    }
    res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
  } catch (error: any) {
    res.writeHead(500, { 'content-type': 'text/plain' }).end(String(error?.message ?? error));
  }
});
server.listen(PORT, '127.0.0.1', () => {
  const info = service.info();
  console.log(`Noren World ID harness on http://127.0.0.1:${PORT}  (pid ${process.pid})`);
  console.log(info.configured ? `World ID: ${info.environment}, credential ${info.credential}, action ${info.action}` : `World ID: Setup required: ${info.missing.join(', ')}`);
  console.log(`Starter line sink: ${info.starterSink}`);
});
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => server.close(() => process.exit(0)));
