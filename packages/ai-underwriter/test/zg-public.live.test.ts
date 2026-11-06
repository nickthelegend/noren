// Live, no key needed: 0G's public Router catalog, the on-chain provider record on 0G mainnet
// (chain 16661) and the provider's TDX quote. These are the public half of the evidence chain.
import { describe, expect, it } from 'vitest'
import { DEFAULT_MODEL, listProviders, readQuoteBinding, readServiceRecord, ZG_NETWORKS } from '../src/index.ts'

describe('0G public evidence for 0GM-1.0 (live)', () => {
  it('the Router lists 0GM-1.0 as TeeML (TDX, dstack)', async () => {
    const res = await fetch(`${ZG_NETWORKS.mainnet.router}/models`)
    const { data } = await res.json() as { data: { id: string; verifiability?: string; tee_type?: string; tee_verifier?: string; supported_parameters?: string[] }[] }
    const m = data.find(x => x.id === DEFAULT_MODEL)
    expect(m, `${DEFAULT_MODEL} missing from /v1/models`).toBeDefined()
    expect(m).toMatchObject({ verifiability: 'TeeML', tee_type: 'TDX', tee_verifier: 'dstack' })
    expect(m!.supported_parameters).toContain('response_format')
  })
  it('its provider is TeeML on-chain, signer acknowledged, and the TDX quote commits to that signer', async () => {
    const providers = (await listProviders(DEFAULT_MODEL)).filter(p => p.verifiability === 'TeeML')
    expect(providers.length).toBeGreaterThan(0)
    for (const p of providers) {
      expect(p.trust_mode).toBe('private')
      const svc = await readServiceRecord(p.address as `0x${string}`)
      expect(svc.verifiability).toBe('TeeML')
      expect(svc.teeSignerAcknowledged).toBe(true)
      expect(svc.model.toLowerCase()).toBe(DEFAULT_MODEL)
      expect(svc.chainId).toBe(16661)
      const q = await readQuoteBinding(svc)
      expect(q.reportDataSigner).toBe(svc.teeSignerAddress)
      expect(q.bindsSigner).toBe(true)
      expect(q.quoteSha256).toMatch(/^[0-9a-f]{64}$/)
      console.log(`provider ${svc.provider} signer ${svc.teeSignerAddress} image ${svc.imageDigest} quote sha256 ${q.quoteSha256} gpu evidence ${q.hasGpuEvidence}`)
    }
  })
})
