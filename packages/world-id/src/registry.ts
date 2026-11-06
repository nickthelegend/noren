import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Nullifier } from '@worldcoin/idkit-core/nullifier';
import type { StarterLine, WorldCredential } from './types.ts';

/**
 * One row per (action, nullifier). The nullifier is World ID's app- and action-scoped number for a
 * person: the same human always produces the same one for "noren-credit", and it can't be linked to
 * their World ID or to any other app. It's stored as a decimal string (World ID's advice: compare
 * numbers, never hex text, so casing or leading zeros can't create a second identity).
 */
export type HumanRecord = {
  action: string;
  nullifier: string;
  credential: WorldCredential;
  verifiedAt: number;
  /** The wallet the proof was bound to (it also becomes the public borrower of the line on Arc). */
  wallet: `0x${string}`;
  starter: StarterLine;
};

type FileShape = { version: 1; humans: HumanRecord[] };

export const nullifierKey = (nullifier: string) => Nullifier.fromHex(nullifier).toBigInt().toString(10);

export class NullifierRegistry {
  private rows: HumanRecord[] | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(readonly file: string) {}

  private async load(): Promise<HumanRecord[]> {
    if (this.rows) return this.rows;
    try {
      const parsed = JSON.parse(await readFile(this.file, 'utf8')) as FileShape;
      if (parsed.version !== 1 || !Array.isArray(parsed.humans)) throw new Error(`${this.file}: unknown format`);
      this.rows = parsed.humans;
    } catch (error: any) {
      if (error?.code !== 'ENOENT') throw error;
      this.rows = [];
    }
    return this.rows;
  }

  private async save(rows: HumanRecord[]) {
    await mkdir(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify({ version: 1, humans: rows } satisfies FileShape, null, 2) + '\n', { mode: 0o600 });
    await rename(tmp, this.file);
  }

  /** Serialises every read-modify-write so two verifications of one human can't both win. */
  private locked<T>(fn: (rows: HumanRecord[]) => Promise<T>): Promise<T> {
    const run = this.queue.then(async () => fn(await this.load()));
    this.queue = run.catch(() => undefined);
    return run;
  }

  async find(action: string, nullifier: string): Promise<HumanRecord | undefined> {
    const key = nullifierKey(nullifier);
    return this.locked(async rows => rows.find(r => r.action === action && r.nullifier === key));
  }

  async findByWallet(action: string, wallet: string): Promise<HumanRecord | undefined> {
    return this.locked(async rows => rows.find(r => r.action === action && r.wallet.toLowerCase() === wallet.toLowerCase()));
  }

  /**
   * Inserts the row if neither the human (action, nullifier) nor the wallet has one yet. This is the
   * UNIQUE constraint: the loser of a race gets `taken` back and nothing is written.
   */
  async claim(record: Omit<HumanRecord, 'nullifier'> & { nullifier: string }): Promise<{ ok: true; record: HumanRecord } | { ok: false; taken: 'human' | 'wallet' }> {
    const row = { ...record, nullifier: nullifierKey(record.nullifier) };
    return this.locked(async rows => {
      if (rows.some(r => r.action === row.action && r.nullifier === row.nullifier)) return { ok: false, taken: 'human' } as const;
      if (rows.some(r => r.action === row.action && r.wallet.toLowerCase() === row.wallet.toLowerCase())) return { ok: false, taken: 'wallet' } as const;
      const next = [...rows, row];
      await this.save(next);
      this.rows = next;
      return { ok: true, record: row } as const;
    });
  }

  async setStarter(action: string, nullifier: string, starter: StarterLine): Promise<void> {
    const key = nullifierKey(nullifier);
    await this.locked(async rows => {
      const next = rows.map(r => (r.action === action && r.nullifier === key ? { ...r, starter } : r));
      await this.save(next);
      this.rows = next;
    });
  }

  async count(): Promise<number> {
    return this.locked(async rows => rows.length);
  }
}
