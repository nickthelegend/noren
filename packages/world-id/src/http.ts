import type { IncomingMessage, ServerResponse } from 'node:http';
import { WorldIdService } from './service.ts';
import { HTTP_STATUS } from './types.ts';

const MAX_BODY = 64 * 1024;

async function readJson(req: IncomingMessage): Promise<any> {
  let size = 0; const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw Object.assign(new Error('Body too large'), { http: 413 });
    chunks.push(chunk as Buffer);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { throw Object.assign(new Error('Body must be JSON'), { http: 400 }); }
}

const send = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
};

/**
 * Mount in packages/server:
 *   const worldId = createWorldIdHandler(new WorldIdService({ config: loadWorldIdConfig(), dataFile, sink: starterSinkFromEnv() }));
 *   if (await worldId(req, res)) return;   // before the server's own routes
 *
 *   GET  /world-id/config            what the app needs to know (no secrets; lists missing setting names)
 *   POST /world-id/request {wallet}  signs a World ID 4.0 request (RP signature) bound to the wallet
 *   POST /world-id/verify  {idkitResponse}  verifies with World, claims the nullifier, opens the starter line
 *   GET  /world-id/status/:wallet    has this wallet's human been verified, and where is the line
 *   POST /world-id/retry   {wallet}  re-sends a starter write that failed or had no sink yet
 *
 * Returns true when it handled the request. CORS is left to the host server.
 */
export function createWorldIdHandler(service: WorldIdService, prefix = '/world-id') {
  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const path = new URL(req.url ?? '/', 'http://local').pathname;
    if (path !== prefix && !path.startsWith(prefix + '/')) return false;
    const route = path.slice(prefix.length);
    try {
      if (req.method === 'GET' && route === '/config') return send(res, 200, service.info()), true;
      if (req.method === 'POST' && route === '/request') {
        const out = await service.request((await readJson(req)).wallet);
        return out.ok ? send(res, 200, out.request) : send(res, HTTP_STATUS[out.result.status], out.result), true;
      }
      if (req.method === 'POST' && route === '/verify') {
        const result = await service.verify((await readJson(req)).idkitResponse);
        return send(res, HTTP_STATUS[result.status], result), true;
      }
      const status = /^\/status\/(0x[0-9a-fA-F]{40})$/.exec(route);
      if (req.method === 'GET' && status) return send(res, 200, await service.status(status[1])), true;
      if (req.method === 'POST' && route === '/retry') return send(res, 200, await service.retryStarter((await readJson(req)).wallet)), true;
      return send(res, 404, { status: 'error', code: 'not_found', detail: `No World ID route ${req.method} ${path}` }), true;
    } catch (error: any) {
      const http = typeof error?.http === 'number' ? error.http : 500;
      const detail = String(error?.message ?? error).slice(0, 200);
      return send(res, http, detail.startsWith('Setup required') ? { status: 'setup_required', detail } : { status: 'error', code: http === 500 ? 'internal' : 'bad_request', detail }), true;
    }
  };
}
