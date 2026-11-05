import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Deployment } from './index.ts';
export async function readDeployment(chainId: number, root = process.cwd()): Promise<Deployment> {
  try {
    const data = JSON.parse(await readFile(resolve(root, 'deployments', `${chainId}.json`), 'utf8')) as Deployment;
    if (data.chainId !== chainId || !data.entrypoint || !data.checkout || !data.pool) throw new Error('invalid deployment');
    return data;
  } catch { throw new Error(`Setup required: deployments/${chainId}.json is missing or invalid`); }
}
