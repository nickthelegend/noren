import { useEffect, useState, useSyncExternalStore } from 'react';
import { bySlug, MAX_QTY, type CartLine } from './catalog.ts';

// ---- tiny hash router ----
export type Route = { path: string; query: URLSearchParams };
const readRoute = (): Route => { const raw = location.hash.replace(/^#/, '') || '/'; const [path, q] = raw.split('?'); return { path: path || '/', query: new URLSearchParams(q ?? '') }; };
export function useRoute() {
  const [route, setRoute] = useState(readRoute);
  useEffect(() => { const on = () => { setRoute(readRoute()); }; addEventListener('hashchange', on); return () => removeEventListener('hashchange', on); }, []);
  return route;
}
export const go = (hash: string) => { if (location.hash !== hash) location.hash = hash; };

// ---- bag (per browser; only a convenience, the backend re-prices everything) ----
const KEY = 'aubelle.bag.v1';
let bag: CartLine[] = (() => { try { const v = JSON.parse(localStorage.getItem(KEY) ?? '[]'); return Array.isArray(v) ? v.filter((l: CartLine) => bySlug(l.slug)) : []; } catch { return []; } })();
const listeners = new Set<() => void>();
const commit = (next: CartLine[]) => { bag = next; try { localStorage.setItem(KEY, JSON.stringify(bag)); } catch { /* private mode */ } listeners.forEach(l => l()); };
export const useBag = () => useSyncExternalStore(cb => { listeners.add(cb); return () => listeners.delete(cb); }, () => bag);
export const bagActions = {
  add(slug: string, size: string) { const hit = bag.find(l => l.slug === slug && l.size === size); commit(hit ? bag.map(l => l === hit ? { ...l, qty: Math.min(MAX_QTY, l.qty + 1) } : l) : [...bag, { slug, size, qty: 1 }]); },
  setQty(slug: string, size: string, qty: number) { commit(qty <= 0 ? bag.filter(l => !(l.slug === slug && l.size === size)) : bag.map(l => l.slug === slug && l.size === size ? { ...l, qty: Math.min(MAX_QTY, qty) } : l)); },
  clear() { commit([]); },
};
export const bagTotal = (lines: CartLine[]) => lines.reduce((s, l) => s + (bySlug(l.slug)?.price ?? 0) * l.qty, 0);
export const bagCount = (lines: CartLine[]) => lines.reduce((s, l) => s + l.qty, 0);

// ---- drawer ----
let drawerOpen = false;
const drawerListeners = new Set<() => void>();
export const setDrawer = (open: boolean) => { drawerOpen = open; drawerListeners.forEach(l => l()); };
export const useDrawer = () => useSyncExternalStore(cb => { drawerListeners.add(cb); return () => drawerListeners.delete(cb); }, () => drawerOpen);

// ---- backend ----
export type Config = { ready: boolean; missing: string[]; webhookError: string | null; server: string | null; merchant: string | null; checkoutBase: string };
export type Fx = { eurPerUsd: number; feed: string; updatedAt: string };
async function getJson<T>(path: string): Promise<T> { const r = await fetch(path); const body = await r.json().catch(() => ({})); if (!r.ok) throw new Error(body.error ?? `HTTP ${r.status}`); return body as T; }
export const api = {
  config: () => getJson<Config>('/api/config'),
  fx: () => getJson<Fx>('/api/fx'),
  order: (id: string) => getJson<any>(`/api/orders/${id}`),
  async checkout(lines: CartLine[]) {
    const r = await fetch('/api/checkout', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ lines }) });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(body.error ?? `Checkout failed (HTTP ${r.status})`);
    return body as { orderId: string; checkoutUrl: string };
  },
};

let fxCache: Promise<Fx | null> | null = null;
export function useFx() {
  const [fx, setFx] = useState<Fx | null>(null);
  useEffect(() => { fxCache ??= api.fx().catch(() => null); fxCache.then(setFx); }, []);
  return fx;
}
export function useConfig() {
  const [config, setConfig] = useState<Config | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { api.config().then(setConfig, e => setError(e.message)); }, []);
  return { config, error };
}
export const eur = (cents: number, fx: Fx | null) => fx ? `€${(cents / 100 * fx.eurPerUsd).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : null;
