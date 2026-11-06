import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { IDKitRequestWidget, passport, proofOfHuman, selfieCheck, type IDKitResult, type Preset } from '@worldcoin/idkit';
import { fetchHumanStatus, fetchWorldConfig, formatUsdc6, requestHuman, resultFromIdkitError, retryStarter, submitProof } from './client.ts';
import type { HumanRequest, HumanStatus, StarterLine, VerifyHumanResult, WorldConfigInfo, WorldCredential } from './types.ts';

const CREDENTIAL_LABEL: Record<WorldCredential, string> = { selfie: 'Selfie Check', proof_of_human: 'Proof of Human', passport: 'Passport' };
const presetFor = (credential: WorldCredential, signal: string): Preset =>
  credential === 'selfie' ? selfieCheck({ signal }) : credential === 'passport' ? passport({ signal }) : proofOfHuman({ signal });

const short = (h: string, n = 6) => (h.length > 2 * n + 2 ? `${h.slice(0, n + 2)}…${h.slice(-n)}` : h);

export type VerifyHumanProps = {
  /** Base URL of the Noren server that mounts createWorldIdHandler (e.g. http://127.0.0.1:8788). */
  serverUrl: string;
  /** The customer's wallet. The proof is bound to it; the starter line opens for it on Arc. */
  wallet?: string;
  onResult?: (result: VerifyHumanResult) => void;
  /** Optional link builder for the starter-line tx (fork or explorer). */
  txHref?: (hash: string) => string | undefined;
};

type Phase = 'loading' | 'ready' | 'signing' | 'open' | 'verifying';

/**
 * "Prove you're a unique human" for the Noren app. Opens World ID through IDKit, sends the result to
 * the Noren server (which verifies it with World and checks the nullifier), then shows the outcome:
 * verified with a starter credit line, already used, cancelled, credential unavailable, expired,
 * rejected or setup required. Noren never learns who the person is.
 */
export function VerifyHuman({ serverUrl, wallet, onResult, txHref }: VerifyHumanProps) {
  useStyles();
  const [phase, setPhase] = useState<Phase>('loading');
  const [cfg, setCfg] = useState<WorldConfigInfo | null>(null);
  const [human, setHuman] = useState<HumanStatus | null>(null);
  const [request, setRequest] = useState<HumanRequest | null>(null);
  const [result, setResult] = useState<VerifyHumanResult | null>(null);
  const serverResult = useRef<VerifyHumanResult | null>(null);

  const finish = useCallback((r: VerifyHumanResult) => {
    setResult(r); setPhase('ready'); setRequest(null); onResult?.(r);
    if (r.status === 'verified' && wallet) fetchHumanStatus(serverUrl, wallet).then(setHuman).catch(() => undefined);
  }, [onResult, serverUrl, wallet]);

  useEffect(() => {
    let live = true;
    setPhase('loading'); setResult(null); setHuman(null);
    Promise.all([fetchWorldConfig(serverUrl), wallet ? fetchHumanStatus(serverUrl, wallet) : Promise.resolve({ verified: false } as HumanStatus)])
      .then(([c, h]) => { if (live) { setCfg(c); setHuman(h); setPhase('ready'); } })
      .catch(e => { if (live) { setResult({ status: 'error', code: 'server_unreachable', detail: `Noren server unreachable: ${e?.message ?? e}` }); setPhase('ready'); } });
    return () => { live = false; };
  }, [serverUrl, wallet]);

  const start = async () => {
    if (!wallet) return;
    setResult(null); serverResult.current = null; setPhase('signing');
    const r = await requestHuman(serverUrl, wallet);
    if (!r.ok) return finish(r.result);
    setRequest(r.request); setPhase('open');
  };

  const handleVerify = async (idkit: IDKitResult) => {
    setPhase('verifying');
    const r = await submitProof(serverUrl, idkit);
    serverResult.current = r;
    if (r.status !== 'verified') throw new Error(r.detail);
  };

  const retry = async () => {
    if (!wallet) return;
    setPhase('verifying');
    const h = await retryStarter(serverUrl, wallet);
    setHuman(h); setPhase('ready');
  };

  const verified = human?.verified ? human : null;
  const busy = phase === 'signing' || phase === 'open' || phase === 'verifying';

  return (
    <section className="nw-card" aria-live="polite">
      <header className="nw-head">
        <span className="nw-mark" aria-hidden><HumanIcon /></span>
        <div className="nw-head-text">
          <h3 className="nw-title">Starter credit for a real human</h3>
          <p className="nw-sub">
            Prove with World ID that you're a unique person and get a {cfg ? formatUsdc6(cfg.starterLimitUsdc6) : '…'} USDC credit line on Arc, no collateral.
            One line per human. Noren never learns who you are.
          </p>
        </div>
      </header>

      {phase === 'loading' && <div className="nw-row nw-muted"><span className="nw-spin" /> Checking World ID…</div>}

      {phase !== 'loading' && cfg && !cfg.configured && (
        <Note tone="warn" title="Setup required">
          The Noren server has no World Developer Portal app yet. Missing: <code>{cfg.missing.join(', ')}</code>.
        </Note>
      )}

      {phase !== 'loading' && verified && <VerifiedLine human={verified} txHref={txHref} onRetry={retry} busy={busy} />}

      {phase !== 'loading' && !verified && cfg?.configured && (
        <div className="nw-actions">
          <button type="button" className="btn ink nw-btn" disabled={!wallet || busy} onClick={start}>
            {phase === 'signing' ? <><span className="nw-spin light" /> Preparing…</>
              : phase === 'open' ? <><span className="nw-spin light" /> Waiting for World ID…</>
              : phase === 'verifying' ? <><span className="nw-spin light" /> Verifying…</>
              : wallet ? `Verify with World ID` : 'Connect a wallet first'}
          </button>
          <span className="nw-meta">{CREDENTIAL_LABEL[cfg.credential]} · {cfg.environment === 'staging' ? 'World ID Simulator' : 'World App'}</span>
        </div>
      )}

      {result && result.status !== 'verified' && <Outcome result={result} onRetry={start} canRetry={!!wallet && !!cfg?.configured} />}

      <details className="nw-privacy">
        <summary>What Noren sees</summary>
        <p>A zero-knowledge proof that a unique human approved this request for this wallet, and a number (the nullifier) that is the same every time that human proves <code>noren-credit</code>, so a second line is refused. No name, face, document or World ID account. The nullifier can't be linked to you in any other app.</p>
      </details>

      {request && (
        <IDKitRequestWidget
          open={phase === 'open' || phase === 'verifying'}
          onOpenChange={open => { if (!open && phase === 'open') finish(resultFromIdkitError('cancelled')); }}
          app_id={request.app_id}
          action={request.action}
          rp_context={request.rp_context}
          environment={request.environment}
          allow_legacy_proofs={false}
          preset={presetFor(request.credential, request.signal)}
          handleVerify={handleVerify}
          onSuccess={() => finish(serverResult.current ?? { status: 'error', code: 'no_result', detail: 'World ID finished but the Noren server sent no result' })}
          onError={code => finish(serverResult.current ?? resultFromIdkitError(String(code)))}
        />
      )}
    </section>
  );
}

function VerifiedLine({ human, txHref, onRetry, busy }: { human: Extract<HumanStatus, { verified: true }>; txHref?: (h: string) => string | undefined; onRetry: () => void; busy: boolean }) {
  const s: StarterLine = human.starter;
  const href = s.status === 'submitted' ? txHref?.(s.txHash) : undefined;
  return (
    <div className="nw-verified">
      <div className="nw-row nw-wrap">
        <span className="nw-badge ok"><Check /> Verified human</span>
        <span className="nw-meta">{CREDENTIAL_LABEL[human.credential]} · {new Date(human.verifiedAt * 1000).toLocaleDateString()}</span>
      </div>
      <dl className="nw-grid">
        <div><dt>Starter limit</dt><dd className="nw-num">{formatUsdc6(s.limitUsdc6)} USDC</dd></div>
        <div><dt>Expires</dt><dd>{new Date(s.expiry * 1000).toLocaleDateString()}</dd></div>
        <div className="nw-span"><dt>Line on Arc</dt><dd className="nw-mono" title={s.lineId}>{short(s.lineId, 8)}</dd></div>
      </dl>
      {s.status === 'submitted' && (
        <p className="nw-muted nw-small">Opened on Arc by the Chainlink CRE workflow · tx {href ? <a href={href} target="_blank" rel="noreferrer" className="nw-mono">{short(s.txHash)}</a> : <span className="nw-mono" title={s.txHash}>{short(s.txHash)}</span>}</p>
      )}
      {s.status !== 'submitted' && (
        <Note tone={s.status === 'failed' ? 'bad' : 'warn'} title={s.status === 'failed' ? 'Line not opened yet' : 'Setup required'}>
          You're verified; the starter line hasn't reached Arc. {s.detail}
          <div><button type="button" className="btn line nw-btn-sm" disabled={busy} onClick={onRetry}>{busy ? 'Retrying…' : 'Try again'}</button></div>
        </Note>
      )}
    </div>
  );
}

function Outcome({ result, onRetry, canRetry }: { result: VerifyHumanResult; onRetry: () => void; canRetry: boolean }) {
  const map: Record<string, { tone: 'warn' | 'bad' | 'info'; title: string; retry: boolean }> = {
    already_used: { tone: 'info', title: 'Already used', retry: false },
    cancelled: { tone: 'info', title: 'Cancelled', retry: true },
    unavailable: { tone: 'warn', title: 'Credential not available', retry: false },
    expired: { tone: 'warn', title: 'Request expired', retry: true },
    invalid: { tone: 'bad', title: 'Proof rejected', retry: true },
    setup_required: { tone: 'warn', title: 'Setup required', retry: false },
    error: { tone: 'bad', title: 'Something went wrong', retry: true },
  };
  const m = map[result.status] ?? map.error;
  const code = 'code' in result ? result.code : undefined;
  return (
    <Note tone={m.tone} title={m.title}>
      {'detail' in result ? result.detail : ''}{code && result.status !== 'unavailable' ? <> <code>{code}</code></> : null}
      {m.retry && canRetry && <div><button type="button" className="btn line nw-btn-sm" onClick={onRetry}>Try again</button></div>}
    </Note>
  );
}

const Note = ({ tone, title, children }: { tone: 'warn' | 'bad' | 'info'; title: string; children: ReactNode }) => (
  <div className={`nw-note ${tone}`} role={tone === 'bad' ? 'alert' : 'status'}><strong>{title}</strong><div>{children}</div></div>
);
const Check = () => <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden><path d="M2.5 6.2 5 8.6l4.6-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>;
const HumanIcon = () => <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden><circle cx="10" cy="10" r="8.2" fill="none" stroke="currentColor" strokeWidth="1.5" /><circle cx="10" cy="8" r="2.6" fill="currentColor" /><path d="M5.6 15.2c.9-2.2 2.5-3.3 4.4-3.3s3.5 1.1 4.4 3.3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>;

const CSS = `
.nw-card{--nw-ink:var(--ink,#17203f);--nw-muted:var(--muted,#5a5f75);--nw-hair:var(--hair,rgba(23,32,63,.1));--nw-ai:var(--ai,#1c2a5e);--nw-wash:var(--ai-wash,rgba(28,42,94,.07));--nw-ok:var(--moss,#2f7a55);--nw-ok-w:var(--moss-wash,rgba(47,122,85,.11));--nw-bad:var(--rust,#b3412c);--nw-bad-w:var(--rust-wash,rgba(179,65,44,.09));--nw-warn:var(--kaki-2,#c4661f);--nw-warn-w:var(--kaki-wash,rgba(217,119,47,.12));
  background:var(--white,#fffdf8);border:1px solid var(--nw-hair);border-radius:14px;padding:18px;display:grid;gap:14px;color:var(--nw-ink);min-width:0;max-width:100%;box-sizing:border-box;font-family:var(--sans,system-ui,sans-serif)}
.nw-head{display:flex;gap:12px;align-items:flex-start;min-width:0}
.nw-head-text{min-width:0}
.nw-mark{flex:none;width:36px;height:36px;border-radius:10px;display:grid;place-items:center;background:var(--nw-wash);color:var(--nw-ai)}
.nw-title{margin:0;font-size:15px;font-weight:700;letter-spacing:-.01em}
.nw-sub{margin:4px 0 0;font-size:13px;line-height:1.5;color:var(--nw-muted)}
.nw-row{display:flex;align-items:center;gap:8px;min-width:0}.nw-wrap{flex-wrap:wrap}
.nw-actions{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.nw-btn{min-width:200px}.nw-btn-sm{margin-top:8px;min-height:32px;padding:0 12px;font-size:13px}
.nw-meta,.nw-muted{font-size:12.5px;color:var(--nw-muted)}.nw-small{font-size:12.5px;margin:0}
.nw-badge{display:inline-flex;align-items:center;gap:6px;padding:4px 10px;border-radius:999px;font-size:12.5px;font-weight:700}
.nw-badge.ok{background:var(--nw-ok-w);color:var(--nw-ok)}
.nw-verified{display:grid;gap:12px}
.nw-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin:0}
.nw-grid>div{background:var(--nw-wash);border-radius:10px;padding:10px 12px;min-width:0}.nw-span{grid-column:1/-1}
.nw-grid dt{font-size:11.5px;color:var(--nw-muted);text-transform:uppercase;letter-spacing:.04em}
.nw-grid dd{margin:2px 0 0;font-size:15px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.nw-num{font-variant-numeric:tabular-nums}.nw-mono{font-family:var(--mono,ui-monospace,monospace);font-size:13px}
.nw-note{border-radius:10px;padding:10px 12px;font-size:13px;line-height:1.5;display:grid;gap:2px;overflow-wrap:anywhere}
.nw-note.info{background:var(--nw-wash)}.nw-note.warn{background:var(--nw-warn-w)}.nw-note.bad{background:var(--nw-bad-w)}
.nw-note.bad strong{color:var(--nw-bad)}.nw-note.warn strong{color:var(--nw-warn)}
.nw-note code,.nw-privacy code{font-family:var(--mono,ui-monospace,monospace);font-size:12px}
.nw-privacy{font-size:12.5px;color:var(--nw-muted)}.nw-privacy summary{cursor:pointer;font-weight:600}.nw-privacy p{margin:6px 0 0;line-height:1.5}
.nw-spin{width:14px;height:14px;border-radius:50%;border:2px solid var(--nw-hair);border-top-color:var(--nw-ai);animation:nw-spin .8s linear infinite;display:inline-block}
.nw-spin.light{border-color:rgba(255,255,255,.35);border-top-color:#fff}
@keyframes nw-spin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.nw-spin{animation-duration:2.4s}}
@media (max-width:420px){.nw-card{padding:14px}.nw-btn{width:100%;min-width:0}.nw-grid{grid-template-columns:1fr}}
`;
function useStyles() {
  useEffect(() => {
    if (typeof document === 'undefined' || document.getElementById('noren-world-id-css')) return;
    const el = document.createElement('style'); el.id = 'noren-world-id-css'; el.textContent = CSS; document.head.appendChild(el);
  }, []);
}

export default VerifyHuman;
