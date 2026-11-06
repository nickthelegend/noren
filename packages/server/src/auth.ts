// MIT
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { generateSiweNonce, parseSiweMessage, verifySiweMessage } from 'viem/siwe';
import { type Address, type Hex } from 'viem';

export const hashSecret = (value: string) => createHash('sha256').update(value).digest('hex');
export const equalHash = (a: string, b: string) => /^[0-9a-f]{64}$/.test(a) && /^[0-9a-f]{64}$/.test(b) && timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
export type Session = { hash: string; address: Address; expiresAt: number; via?: 'siwe' | 'privy'; privyUserId?: string };
type PrivyCheck = { verify: (token: unknown) => Promise<{ userId: string }> };

export class AuthState {
  nonces = new Map<string, number>();
  sessions: Session[] = [];
  constructor(private client: any, private chainId: number, private domains: string[], private now = () => Date.now()) {}
  nonce() { const value = generateSiweNonce(); this.nonces.set(value, this.now() + 600_000); return value; }
  /** Checks a SIWE message (nonce issued here and unused, allowed domain, this chain, fresh) and its signature. */
  private async check(message: string, signature: Hex) {
    let parsed: ReturnType<typeof parseSiweMessage>;
    try { parsed = parseSiweMessage(message); } catch { throw new Error('SiweInvalid: malformed message'); }
    const nonce = parsed.nonce;
    if (!nonce || !this.nonces.has(nonce)) throw new Error('SiweInvalid: nonce was not issued or was already used');
    const validUntil = this.nonces.get(nonce)!; this.nonces.delete(nonce);
    if (validUntil < this.now()) throw new Error('SiweInvalid: nonce expired');
    if (!parsed.domain || !this.domains.includes(parsed.domain)) throw new Error('SiweInvalid: domain is not allowed');
    if (parsed.chainId !== this.chainId) throw new Error('SiweInvalid: wrong chain');
    const issued = parsed.issuedAt?.getTime();
    if (!issued || issued > this.now() || this.now() - issued > 600_000) throw new Error('SiweInvalid: issuedAt must be within 10 minutes');
    if (parsed.expirationTime && parsed.expirationTime.getTime() <= this.now()) throw new Error('SiweInvalid: message expired');
    if (!parsed.address || typeof signature !== 'string') throw new Error('SiweInvalid: address or signature missing');
    try { if (!await verifySiweMessage(this.client, { message, signature, time: new Date(this.now()) })) throw new Error('invalid signature'); }
    catch { throw new Error('SiweInvalid: invalid signature'); }
    return parsed as typeof parsed & { address: Address };
  }
  async siwe(message: string, signature: Hex) {
    const parsed = await this.check(message, signature);
    return this.issue(parsed.address, { via: 'siwe' });
  }
  /**
   * Sign in with Privy: a valid Privy access token for this app (checked against Privy's public JWKS) plus a SIWE
   * signature from the Privy user's wallet (embedded or linked) whose resources name that Privy user. The token proves
   * who logged in; the signature proves they control the address the merchant account is keyed by.
   */
  async privy(verifier: PrivyCheck | null, accessToken: unknown, message: string, signature: Hex) {
    if (!verifier) throw new Error('Setup required: PRIVY_APP_ID is not set on the Noren server');
    const claims = await verifier.verify(accessToken);
    const parsed = await this.check(message, signature);
    if (!parsed.resources?.includes(claims.userId)) throw new Error('SiweInvalid: the signed message is not bound to this Privy user');
    return { ...this.issue(parsed.address, { via: 'privy', privyUserId: claims.userId }), privyUserId: claims.userId };
  }
  private issue(address: Address, extra: Pick<Session, 'via' | 'privyUserId'>) {
    const session = `sess_${randomBytes(32).toString('hex')}`;
    const expiresAt = Math.floor(this.now() / 1000) + 86400;
    this.sessions.push({ hash: hashSecret(session), address, expiresAt, ...extra });
    return { session, address, expiresAt, via: extra.via };
  }
  address(token: string): Address | undefined { const hash = hashSecret(token); return this.sessions.find(s => equalHash(s.hash, hash) && s.expiresAt > Math.floor(this.now() / 1000))?.address; }
  logout(token: string) { const hash = hashSecret(token); this.sessions = this.sessions.filter(s => !equalHash(s.hash, hash)); }
}
