/** Small dashboard kit: toasts, menus, modals, QR, CSV, a line chart, and on-chain reads. No mock data anywhere. */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import qrcode from "qrcode-generator";

/* ------------------------------------------------------------------ toasts */
type Toast = { id: number; text: string; tone: "ok" | "err" };
const listeners = new Set<(t: Toast[]) => void>();
let toasts: Toast[] = [];
export function toast(text: string, tone: Toast["tone"] = "ok") {
  const t = { id: Date.now() + Math.random(), text, tone };
  toasts = [...toasts, t]; listeners.forEach((l) => l(toasts));
  setTimeout(() => { toasts = toasts.filter((x) => x.id !== t.id); listeners.forEach((l) => l(toasts)); }, 3800);
}
export function Toasts() {
  const [list, setList] = useState<Toast[]>(toasts);
  useEffect(() => { listeners.add(setList); return () => { listeners.delete(setList); }; }, []);
  return <div className="sd-toasts" role="status" aria-live="polite">{list.map((t) => <div key={t.id} className={`sd-toast ${t.tone}`}>{t.text}</div>)}</div>;
}

/* ------------------------------------------------------------------ menu */
export function Menu({ trigger, items, align = "right" }: { trigger: (open: () => void, isOpen: boolean) => ReactNode; items: ([string, () => void, boolean?] | "sep")[]; align?: "left" | "right" }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const off = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    addEventListener("mousedown", off); addEventListener("keydown", esc);
    return () => { removeEventListener("mousedown", off); removeEventListener("keydown", esc); };
  }, [open]);
  return (
    <div className="sd-menu-wrap" ref={ref} onClick={(e) => e.stopPropagation()}>
      {trigger(() => setOpen((o) => !o), open)}
      {open && (
        <div className={`sd-menu ${align}`} role="menu">
          {items.map((it, i) => it === "sep" ? <hr key={i} /> : <button key={it[0]} role="menuitem" disabled={it[2] === false} className={/refund|delete|remove/i.test(it[0]) ? "danger" : ""} onClick={() => { setOpen(false); it[1](); }}>{it[0]}</button>)}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ modal */
export function Modal({ title, onClose, children, wide, footer }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean; footer?: ReactNode }) {
  useEffect(() => { const k = (e: KeyboardEvent) => e.key === "Escape" && onClose(); addEventListener("keydown", k); const o = document.body.style.overflow; document.body.style.overflow = "hidden"; return () => { removeEventListener("keydown", k); document.body.style.overflow = o; }; }, [onClose]);
  return (
    <div className="sd-modal-bg" onMouseDown={onClose}>
      <div className={`sd-modal ${wide ? "wide" : ""}`} role="dialog" aria-modal="true" aria-label={title} onMouseDown={(e) => e.stopPropagation()}>
        <header><h2>{title}</h2><button className="sd-icon-btn" onClick={onClose} aria-label="Close">✕</button></header>
        <div className="sd-modal-body">{children}</div>
        {footer && <footer>{footer}</footer>}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ QR */
export function QR({ text, size = 168 }: { text: string; size?: number }) {
  const svg = useMemo(() => { const q = qrcode(0, "M"); q.addData(text); q.make(); return q.createSvgTag({ cellSize: 4, margin: 0, scalable: true }); }, [text]);
  return <div className="sd-qr" style={{ width: size, height: size }} aria-label="QR code for the payment link" role="img" dangerouslySetInnerHTML={{ __html: svg }} />;
}

/* ------------------------------------------------------------------ CSV */
export function downloadCsv(name: string, rows: (string | number)[][]) {
  const esc = (v: string | number) => { const s = String(v ?? ""); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const blob = new Blob([rows.map((r) => r.map(esc).join(",")).join("\n")], { type: "text/csv" });
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/* ------------------------------------------------------------------ chain reads (raw eth_call, no wallet) */
const pad = (a: string) => a.toLowerCase().replace(/^0x/, "").padStart(64, "0");
export async function ethCall(rpc: string, to: string, data: string): Promise<string> {
  const r = await fetch(rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to, data }, "latest"] }) });
  const j = await r.json(); if (j.error) throw new Error(j.error.message); return j.result as string;
}
export const erc20Balance = async (rpc: string, token: string, owner: string) => BigInt(await ethCall(rpc, token, "0x70a08231" + pad(owner)));
/** NorenCheckout.merchantPayout(address) → address */
export const payoutOf = async (rpc: string, checkout: string, merchant: string) => "0x" + (await ethCall(rpc, checkout, "0x27f757c7" + pad(merchant))).slice(-40);

/* ------------------------------------------------------------------ line chart */
export type Series = { label: string; values: number[]; dashed?: boolean };
export function LineChart({ series, labels, height = 180, format = (v: number) => v.toFixed(2), compact }: { series: Series[]; labels: string[]; height?: number; format?: (v: number) => string; compact?: boolean }) {
  const [hover, setHover] = useState<number | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const n = labels.length, max = Math.max(1e-9, ...series.flatMap((s) => s.values)), W = 600, H = height;
  const x = (i: number) => (n <= 1 ? W / 2 : (i / (n - 1)) * W), y = (v: number) => H - 6 - (v / max) * (H - 18);
  const path = (vals: number[]) => vals.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const main = series[0];
  const onMove = (e: React.MouseEvent) => { const r = ref.current!.getBoundingClientRect(); const i = Math.round(((e.clientX - r.left) / r.width) * (n - 1)); setHover(Math.max(0, Math.min(n - 1, i))); };
  return (
    <div className={`sd-chart ${compact ? "compact" : ""}`} ref={ref} onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden>
        <defs><linearGradient id="sdfill" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor="var(--sd-accent)" stopOpacity=".18" /><stop offset="1" stopColor="var(--sd-accent)" stopOpacity="0" /></linearGradient></defs>
        {!compact && [0.25, 0.5, 0.75].map((f) => <line key={f} x1="0" x2={W} y1={H * f} y2={H * f} className="grid" />)}
        <path d={`${path(main.values)} L${x(main.values.length - 1)},${H} L${x(0)},${H} Z`} fill="url(#sdfill)" />
        {main.values.length < n && <circle cx={x(main.values.length - 1)} cy={y(main.values[main.values.length - 1] ?? 0)} r="3.5" className="now" vectorEffect="non-scaling-stroke" />}
        {series.map((s, k) => <path key={s.label} d={path(s.values)} className={`ln ${s.dashed ? "dashed" : ""} k${k}`} vectorEffect="non-scaling-stroke" />)}
        {hover !== null && <line x1={x(hover)} x2={x(hover)} y1="0" y2={H} className="cursor" vectorEffect="non-scaling-stroke" />}
      </svg>
      {hover !== null && (
        <div className="sd-tip" style={{ left: `${(x(hover) / W) * 100}%` }}>
          <b>{labels[hover]}</b>
          {series.map((s) => <span key={s.label}><i className={s.dashed ? "dashed" : ""} />{s.label}: {format(s.values[hover] ?? 0)}</span>)}
        </div>
      )}
    </div>
  );
}
