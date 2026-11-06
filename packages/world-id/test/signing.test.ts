import { describe, expect, it } from 'vitest';
import { bytesToHex, hexToBytes, keccak256, recoverMessageAddress, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { hashSignal } from '@worldcoin/idkit-core/hashing';
import { computeRpSignatureMessage, signNorenRequest } from '../src/signing.ts';
import { NOREN_CREDIT_ACTION } from '../src/config.ts';

// A throwaway key generated for this test file only; it signs nothing outside these tests.
const TEST_KEY = keccak256(toHex('noren world-id signing test key'));
const NONCE = '0x008ae1aa597fa146ebd3aa2ceddf360668dea5e526567e92b0321816a4e895bd';

describe('RP request signing (World ID 4.0)', () => {
  it('builds the 49- and 81-byte messages from the RP signature spec test vectors', () => {
    expect(bytesToHex(computeRpSignatureMessage(hexToBytes(NONCE), 1700000000, 1700000300)))
      .toBe('0x01008ae1aa597fa146ebd3aa2ceddf360668dea5e526567e92b0321816a4e895bd000000006553f100000000006553f22c');
    expect(bytesToHex(computeRpSignatureMessage(hexToBytes(NONCE), 1700000000, 1700000300, 'test-action')))
      .toBe('0x01008ae1aa597fa146ebd3aa2ceddf360668dea5e526567e92b0321816a4e895bd000000006553f100000000006553f22c00aa0ce59768ae5b1c52f07a9387f14f09f277422c0d2f8a268c7bad0c60a46a');
  });

  it('hashes signals with the spec hash_to_field vectors', () => {
    expect(hashSignal('')).toBe('0x00c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a4');
    expect(hashSignal('test_signal')).toBe('0x00c1636e0a961a3045054c4d61374422c31a95846b8442f0927ad2ff1d6112ed');
    // A wallet signal is hashed as bytes, so checksum casing cannot change the hash.
    expect(hashSignal('0x70997970C51812dc3A010C7d01b50e0d17dc79C8')).toBe(hashSignal('0x70997970c51812dc3a010c7d01b50e0d17dc79c8'));
  });

  it('signs noren-credit requests that recover to the RP signer, with a 300 s lifetime', async () => {
    const rp = signNorenRequest(TEST_KEY, NOREN_CREDIT_ACTION);
    expect(rp.expires_at - rp.created_at).toBe(300);
    expect(rp.nonce).toMatch(/^0x00[0-9a-f]{62}$/); // a field element: top byte cleared
    const msg = computeRpSignatureMessage(hexToBytes(rp.nonce as `0x${string}`), rp.created_at, rp.expires_at, NOREN_CREDIT_ACTION);
    expect(msg.length).toBe(81);
    const signer = await recoverMessageAddress({ message: { raw: msg }, signature: rp.signature as `0x${string}` });
    expect(signer).toBe(privateKeyToAccount(TEST_KEY).address);
  });

  it('binds the action: a signature for noren-credit does not verify for another action', async () => {
    const rp = signNorenRequest(TEST_KEY, NOREN_CREDIT_ACTION);
    const other = computeRpSignatureMessage(hexToBytes(rp.nonce as `0x${string}`), rp.created_at, rp.expires_at, 'claim-airdrop');
    const signer = await recoverMessageAddress({ message: { raw: other }, signature: rp.signature as `0x${string}` });
    expect(signer).not.toBe(privateKeyToAccount(TEST_KEY).address);
  });

  it('uses a fresh nonce every time', () => {
    const a = signNorenRequest(TEST_KEY, NOREN_CREDIT_ACTION), b = signNorenRequest(TEST_KEY, NOREN_CREDIT_ACTION);
    expect(a.nonce).not.toBe(b.nonce);
  });

  it('fails loudly without a key and never echoes a malformed key', () => {
    expect(() => signNorenRequest(undefined, NOREN_CREDIT_ACTION)).toThrow('Setup required: WORLD_RP_SIGNING_KEY');
    const bad = 'deadbeef'.repeat(7);
    try { signNorenRequest(bad, NOREN_CREDIT_ACTION); expect.unreachable(); } catch (e: any) { expect(e.message).not.toContain(bad); expect(e.message).toContain('32-byte hex'); }
  });
});
