/* Shared runtime: the global lens, the API client, and the shell chrome.
   Every page imports this and declares which panels it draws. One lens change
   re-runs every registered panel's fetch. */

import { DOWS, DOWS_LONG, MONTHS, MONTHS_LONG } from './charts';

export interface Lens {
  mon: number | null;
  dow: number | null;
  hod: number | null;
  kind: 'all' | 'dry' | 'rain' | 'snow';
}

const LENS: Lens = { mon: null, dow: null, hod: null, kind: 'all' };

export const lens = () => LENS;
/** Click-to-filter: a panel can push one dimension into the global lens. */
export function setLens(patch: Partial<Lens>) {
  Object.assign(LENS, patch);
  void refresh();
}
export const isFiltered = () =>
  LENS.mon != null || LENS.dow != null || LENS.hod != null || LENS.kind !== 'all';

export function lensQuery(extra: Record<string, string | number> = {}): string {
  const q = new URLSearchParams();
  if (LENS.mon != null) q.set('mon', String(LENS.mon));
  if (LENS.dow != null) q.set('dow', String(LENS.dow));
  if (LENS.hod != null) q.set('hod', String(LENS.hod));
  if (LENS.kind !== 'all') q.set('kind', LENS.kind);
  for (const k in extra) q.set(k, String(extra[k]));
  return q.toString();
}

export function lensText(): string {
  const bits: string[] = [];
  if (LENS.mon != null) bits.push(MONTHS_LONG[LENS.mon - 1]);
  if (LENS.dow != null) bits.push(DOWS_LONG[LENS.dow]);
  if (LENS.hod != null) bits.push(`${String(LENS.hod).padStart(2, '0')}:00–${String((LENS.hod + 1) % 24).padStart(2, '0')}:00`);
  if (LENS.kind === 'dry') bits.push('dry hours only');
  if (LENS.kind === 'rain') bits.push('rain and drizzle only');
  if (LENS.kind === 'snow') bits.push('snowing hours only');
  return bits.length ? bits.join(' · ') : 'the whole year';
}

/** Fetch a pipeline. Throws on a non-2xx or an {error} body so panels can show
 *  a real failure instead of an empty chart. */
export async function api<T>(path: string, extra: Record<string, string | number> = {}): Promise<T> {
  const qs = lensQuery(extra);
  const res = await fetch(`/api/${path}${qs ? '?' + qs : ''}`, { headers: { accept: 'application/json' } });
  const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  if (!res.ok || (body && typeof body === 'object' && 'error' in body)) {
    throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
  }
  return body as T;
}

/* --------------------------------------------------------------- registry -- */
type PanelFn = (re: boolean) => void | Promise<void>;
const PANELS: PanelFn[] = [];
export function register(fn: PanelFn) { PANELS.push(fn); }

let runToken = 0;
export async function refresh() {
  const mine = ++runToken;
  syncChrome();
  await Promise.allSettled(PANELS.map((p) => Promise.resolve(p(false)).catch(() => {})));
  if (mine !== runToken) return;
}

/** Attach a skeleton to a host, and swap in an error state on failure. */
export function panelState(host: HTMLElement, state: 'loading' | 'ready' | 'error', msg?: string) {
  host.dataset.state = state;
  if (state === 'error') {
    host.innerHTML = '';
    const p = document.createElement('p');
    p.className = 'panel__error';
    p.textContent = msg ?? 'This panel could not be drawn.';
    host.append(p);
  }
}

/* ----------------------------------------------------------------- chrome -- */
function buildSelect(id: string, items: { v: string; l: string }[], all: string) {
  const sel = document.getElementById(id) as HTMLSelectElement | null;
  if (!sel) return;
  while (sel.options.length) sel.remove(0);
  const o = new Option(all, 'all');
  sel.add(o);
  for (const it of items) sel.add(new Option(it.l, it.v));
}

export function syncChrome() {
  const any = isFiltered();
  const rt = document.getElementById('lens-text');
  if (rt) rt.textContent = lensText();
  const rb = document.getElementById('lens-reset') as HTMLButtonElement | null;
  if (rb) rb.disabled = !any;
  const rr = document.getElementById('lens-readout');
  if (rr) rr.classList.toggle('is-filtered', any);
  const selM = document.getElementById('f-mon') as HTMLSelectElement | null;
  if (selM) selM.value = LENS.mon != null ? String(LENS.mon) : 'all';
  const selD = document.getElementById('f-dow') as HTMLSelectElement | null;
  if (selD) selD.value = LENS.dow != null ? String(LENS.dow) : 'all';
  const selH = document.getElementById('f-hod') as HTMLSelectElement | null;
  if (selH) selH.value = LENS.hod != null ? String(LENS.hod) : 'all';
  document.querySelectorAll<HTMLButtonElement>('.seg [data-kind]').forEach((b) => {
    b.setAttribute('aria-pressed', String(b.dataset.kind === LENS.kind));
  });
  // deep-linkable lens
  const qs = lensQuery();
  const url = location.pathname + (qs ? '?' + qs : '');
  history.replaceState(null, '', url);
}

export function initChrome() {
  buildSelect('f-mon', MONTHS.map((m, i) => ({ v: String(i + 1), l: MONTHS_LONG[i] })), 'All year');
  buildSelect('f-dow', DOWS.map((d, i) => ({ v: String(i), l: DOWS_LONG[i] })), 'All week');
  buildSelect('f-hod', Array.from({ length: 24 }, (_, i) => ({ v: String(i), l: `${String(i).padStart(2, '0')}:00–${String((i + 1) % 24).padStart(2, '0')}:00` })), 'All hours');

  const on = (id: string, apply: (v: string) => void) => {
    document.getElementById(id)?.addEventListener('change', (e) => apply((e.target as HTMLSelectElement).value));
  };
  on('f-mon', (v) => { LENS.mon = v === 'all' ? null : Number(v); void refresh(); });
  on('f-dow', (v) => { LENS.dow = v === 'all' ? null : Number(v); void refresh(); });
  on('f-hod', (v) => { LENS.hod = v === 'all' ? null : Number(v); void refresh(); });
  document.querySelectorAll<HTMLButtonElement>('.seg [data-kind]').forEach((b) => {
    b.addEventListener('click', () => {
      LENS.kind = (b.dataset.kind as Lens['kind']) ?? 'all';
      void refresh();
    });
  });
  document.getElementById('lens-reset')?.addEventListener('click', () => {
    LENS.mon = null; LENS.dow = null; LENS.hod = null; LENS.kind = 'all';
    void refresh();
  });

  // Read the lens out of the URL so a filtered view is shareable, then verify Mongo.
  const u = new URL(location.href);
  const n = (k: string) => { const v = u.searchParams.get(k); return v && v !== 'all' ? Number(v) : null; };
  LENS.mon = n('mon'); LENS.dow = n('dow'); LENS.hod = n('hod');
  const k = u.searchParams.get('kind');
  LENS.kind = k === 'dry' || k === 'rain' || k === 'snow' ? k : 'all';

  void probeDb();
}

async function probeDb() {
  const dot = document.getElementById('db-dot');
  const label = document.getElementById('db-state');
  const rows = document.getElementById('side-rows');
  try {
    const t0 = performance.now();
    const res = await fetch('/api/meta', { headers: { accept: 'application/json' } });
    const d = await res.json();
    const ms = Math.round(performance.now() - t0);
    if (dot) dot.classList.add('is-ok');
    if (label) label.textContent = `MongoDB · ${d?.counts?.trips ? Intl.NumberFormat('en-US').format(d.counts.trips) : ''} docs · ${ms} ms`;
    if (rows && d?.provenance?.sourceRows) rows.textContent = Intl.NumberFormat('en-US').format(d.provenance.sourceRows);
  } catch {
    if (dot) dot.classList.add('is-bad');
    if (label) label.textContent = 'MongoDB unreachable';
  }
}

/* ------------------------------------------------------------------ boot -- */
export function boot(buildPage: () => void) {
  initChrome();
  buildPage();
  void refresh();
  const rerender = () => void refresh();
  let t: number | undefined;
  window.addEventListener('resize', () => {
    if (t) clearTimeout(t);
    t = setTimeout(rerender, 180) as unknown as number;
  }, { passive: true });
}

export { DOWS, MONTHS };
