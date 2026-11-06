import { describe, expect, it } from 'vitest';
import { afterRelayFee, decodeRelayData, encodeRelayData, type Deployment } from '@noren/core';
import { createPrivateRelay, parsePrivateSend } from './private.ts';

// Anvil's published dev key #0 (never holds real funds). These checks all fail before any RPC call, so the
// unreachable RPC below is never contacted; the live relay runs in scripts/live/private-live.ts.
const relayerKey = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const;
const relayer = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const deployment: Deployment = { chainId: 5042002, deploymentBlock: '1', usdc: '0x3600000000000000000000000000000000000000', entrypoint: '0xa22f3200ecb4319b48dca49677c2f73cd7260ad5', pool: '0x393d8d46e1dff8a719820e36d70ba509896ea57d', checkout: '0xe18a80506fdb7f5498aad7387a21134118a77547' };
const recipient = '0x00000000000000000000000000000000000000aa';
const proof = { pA: ['1', '2'], pB: [['3', '4'], ['5', '6']], pC: ['7', '8'], pubSignals: ['9', '10', '500000', '11', '12', '13', '14', '15'] };
const relay = createPrivateRelay({ deployment, rpcUrl: 'http://127.0.0.1:1', relayerKey, feeBps: 50n });
const body = (over: Partial<{ processooor: string; recipient: string; feeRecipient: string; fee: bigint }> = {}) => ({
  withdrawal: { processooor: over.processooor ?? deployment.entrypoint, data: encodeRelayData({ recipient: (over.recipient ?? recipient) as any, feeRecipient: (over.feeRecipient ?? relayer) as any, relayFeeBps: over.fee ?? 50n }) },
  proof, scope: '1',
});

describe('private send relay', () => {
  it('round-trips RelayData and computes the fee like Entrypoint._deductFee', () => {
    const d = decodeRelayData(encodeRelayData({ recipient, feeRecipient: relayer, relayFeeBps: 50n }));
    expect(d.recipient.toLowerCase()).toBe(recipient);
    expect(d.relayFeeBps).toBe(50n);
    expect(afterRelayFee(1_000_000n, 50n)).toBe(995_000n);
    expect(afterRelayFee(1_000_000n, 0n)).toBe(1_000_000n);
  });
  it('parses the JSON proof into Solidity arguments', () => {
    const p = parsePrivateSend(body());
    expect(p.proof.pubSignals[2]).toBe(500_000n);
    expect(p.proof.pB[1][0]).toBe(5n);
    expect(() => parsePrivateSend({ ...body(), proof: { ...proof, pubSignals: proof.pubSignals.slice(0, 7) } })).toThrow(/WithdrawProof/);
    expect(() => parsePrivateSend({ ...body(), proof: { ...proof, pA: ['x', '1'] } })).toThrow(/integer/);
  });
  it('refuses withdrawals the relayer must not sign', async () => {
    expect(relay.address).toBe(relayer);
    await expect(relay.relay(body({ processooor: deployment.checkout }))).rejects.toThrow(/Entrypoint/);
    await expect(relay.relay(body({ feeRecipient: recipient }))).rejects.toThrow(/feeRecipient must be this relayer/);
    await expect(relay.relay(body({ fee: 500n }))).rejects.toThrow(/relayFeeBPS must be 50/);
    await expect(relay.relay(body({ recipient: '0x0000000000000000000000000000000000000000' }))).rejects.toThrow(/non-zero/);
    await expect(relay.relay({ ...body(), withdrawal: { processooor: deployment.entrypoint, data: '0x1234' } })).rejects.toThrow(/RelayData/);
  });
});
