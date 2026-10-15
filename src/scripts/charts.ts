/* Dashboard chart primitives. Hand-drawn SVG, no chart library. Every renderer
   takes a container, surveys its pixel width, and draws at that exact size so
   type stays at its true size at every breakpoint. */

const NS = 'http://www.w3.org/2000/svg';

export function s(tag: string, attrs: Record<string, string | number | undefined | null> = {}, kids: (Node | string)[] = []): SVGElement {
  const el = document.createElementNS(NS, tag);
  for (const k in attrs) {
    const v = attrs[k];
    if (v === undefined || v === null || v === '') continue;
    el.setAttribute(k, String(v));
  }
  for (const kid of kids) el.append(kid);
  return el;
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number | undefined> = {},
  kids: (Node | string)[] = [],
): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  for (const k in attrs) if (attrs[k] !== undefined) n.setAttribute(k, String(attrs[k]));
  for (const c of kids) n.append(c);
  return n;
}

export const clear = (n: Element) => { while (n.firstChild) n.removeChild(n.firstChild); };

export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const DOWS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
export const DOWS_LONG = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

const f0 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const f1 = new Intl.NumberFormat('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const f2 = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const int = (n: number) => f0.format(Math.round(n));
export const one = (n: number) => f1.format(n);
export const two = (n: number) => f2.format(n);

export function money(n: number, precise = false): string {
  const a = Math.abs(n);
  if (precise) return '$' + f2.format(n);
  if (a >= 1e9) return '$' + f1.format(n / 1e9) + 'B';
  if (a >= 1e6) return '$' + f1.format(n / 1e6) + 'M';
  if (a >= 1e4) return '$' + f0.format(Math.round(n / 1e3)) + 'k';
  if (a >= 1e3) return '$' + f1.format(n / 1e3) + 'k';
  return '$' + f0.format(Math.round(n));
}

export function compact(n: number): string {
  const a = Math.abs(n);
  if (a >= 1e6) return f1.format(n / 1e6) + 'M';
  if (a >= 1e4) return f0.format(Math.round(n / 1e3)) + 'k';
  if (a >= 1e3) return f1.format(n / 1e3) + 'k';
  return f0.format(Math.round(n));
}

export function scale(d0: number, d1: number, r0: number, r1: number) {
  const k = d1 === d0 ? 0 : (r1 - r0) / (d1 - d0);
  const f = (v: number) => r0 + (v - d0) * k;
  f.invert = (p: number) => d0 + (p - r0) / k;
  return f;
}

export function niceMax(v: number, steps = 4): number {
  if (v <= 0) return 1;
  const raw = v / steps;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const n = raw / mag;
  const m = n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10;
  return m * mag * steps;
}

export const ticks = (lo: number, hi: number, n = 4) =>
  Array.from({ length: n + 1 }, (_, i) => lo + ((hi - lo) * i) / n);

export function linePath(pts: number[]): string {
  let d = '';
  for (let i = 0; i < pts.length; i += 2) d += (i === 0 ? 'M' : 'L') + pts[i].toFixed(1) + ' ' + pts[i + 1].toFixed(1);
  return d;
}

export function areaPath(top: number[], baseY: number): string {
  if (!top.length) return '';
  const back: number[] = [];
  for (let i = top.length - 2; i >= 0; i -= 2) back.push(top[i], baseY);
  return linePath(top) + linePath(back) + 'Z';
}

export function tick(x: number, y: number, text: string, anchor: string, size = 10): SVGElement {
  return s('text', {
    x, y, 'text-anchor': anchor, 'font-size': size, fill: 'var(--ink-3)',
    'font-variant-numeric': 'tabular-nums',
  }, [text]);
}

/** In a responsive SVG, draw at the container's own pixel width. */
export function frame(host: HTMLElement, h: number): { svg: SVGElement; W: number; H: number } {
  const W = Math.max(240, Math.floor(host.clientWidth || 480));
  const svg = s('svg', { width: '100%', viewBox: `0 0 ${W} ${h}`, height: h, role: 'img', preserveAspectRatio: 'xMidYMid meet' });
  return { svg, W, H: h };
}

export function mount(host: HTMLElement, svg: SVGElement) {
  clear(host);
  host.append(svg);
}

export function resize(fn: () => void, ms = 150) {
  let t: number | undefined;
  const h = () => { if (t) clearTimeout(t); t = setTimeout(fn, ms) as unknown as number; };
  window.addEventListener('resize', h, { passive: true });
  return () => window.removeEventListener('resize', h);
}

export function raf(fn: () => void) {
  let q = false;
  return () => { if (q) return; q = true; requestAnimationFrame(() => { q = false; fn(); }); };
}

/* ------------------------------------------------------------------ charts -- */

export interface Point { key: string | number; label: string; value: number; value2?: number; colour?: string }

/** Vertical bars with an optional second series drawn as a line on its own scale. */
export function barChart(
  host: HTMLElement,
  data: Point[],
  opts: {
    height?: number;
    yLabel?: string;
    y2Label?: string;
    fmt?: (v: number) => string;
    fmt2?: (v: number) => string;
    colour?: string;
    colour2?: string;
    highlight?: (p: Point, i: number) => boolean;
    onSelect?: (p: Point, i: number) => void;
    labels?: boolean;
  } = {},
) {
  const H = opts.height ?? 190;
  const { svg, W } = frame(host, H);
  const hasSecond = data.some((d) => d.value2 != null) || !!opts.y2Label;
  const mL = 46, mR = hasSecond ? 50 : 12, mT = 16, mB = 28;
  const iw = W - mL - mR, ih = H - mT - mB;
  const max = niceMax(Math.max(...data.map((d) => d.value), 1));
  const y = scale(0, max, mT + ih, mT);
  const bw = iw / data.length;
  const fmt = opts.fmt ?? compact;

  for (const t of ticks(0, max, 3)) {
    svg.append(s('line', { x1: mL, x2: mL + iw, y1: y(t), y2: y(t), stroke: 'var(--rule)', 'stroke-width': 1 }));
    svg.append(tick(mL - 7, y(t) + 3.5, fmt(t), 'end'));
  }

  data.forEach((d, i) => {
    const x = mL + i * bw;
    const on = opts.highlight?.(d, i) ?? false;
    if (on) svg.append(s('rect', { x, y: mT - 6, width: bw, height: ih + 6, fill: 'var(--plane)' }));
    const top = y(d.value);
    svg.append(s('rect', {
      x: x + bw * 0.14, y: top, width: bw * 0.72, height: Math.max(0.8, mT + ih - top),
      fill: d.colour ?? opts.colour ?? 'var(--ink)', 'fill-opacity': on ? 0.95 : 0.74,
    }));
    if (opts.labels !== false) svg.append(tick(x + bw / 2, mT + ih + 13, d.label, 'middle', 9.5));
    if (opts.onSelect) {
      const hit = s('rect', { x, y: mT, width: bw, height: ih, fill: 'transparent', style: 'cursor:pointer' });
      hit.addEventListener('click', () => opts.onSelect!(d, i));
      svg.append(hit);
    }
  });

  if (hasSecond) {
    const max2 = niceMax(Math.max(...data.map((d) => d.value2 ?? 0), 1));
    const y2 = scale(0, max2, mT + ih, mT);
    for (const t of ticks(0, max2, 3)) svg.append(tick(W - mR + 7, y2(t) + 3.5, (opts.fmt2 ?? compact)(t), 'start'));
    const pts: number[] = [];
    data.forEach((d, i) => pts.push(mL + i * bw + bw / 2, y2(d.value2 ?? 0)));
    svg.append(s('path', { d: linePath(pts), fill: 'none', stroke: opts.colour2 ?? 'var(--rev)', 'stroke-width': 1.7 }));
    data.forEach((d, i) => svg.append(s('circle', { cx: mL + i * bw + bw / 2, cy: y2(d.value2 ?? 0), r: 2.4, fill: opts.colour2 ?? 'var(--rev)' })));
    if (opts.y2Label) svg.append(s('text', { x: W - mR + 7, y: mT - 6, 'font-size': 9, fill: 'var(--ink-3)' }, [opts.y2Label]));
  }

  svg.append(s('line', { x1: mL, x2: mL + iw, y1: mT + ih, y2: mT + ih, stroke: 'var(--rule-ink)', 'stroke-width': 1 }));
  if (opts.yLabel) svg.append(s('text', { x: mL - 7, y: mT - 5, 'text-anchor': 'end', 'font-size': 9, fill: 'var(--ink-3)' }, [opts.yLabel]));
  mount(host, svg);
}

/**
 * Horizontal bars for ranked categories with long names.
 *
 * Signed data is drawn about a zero line: negatives grow left, positives right.
 * A chart that silently clamps negative values to a one-pixel stub at the origin
 * is worse than no chart, so the zero position is computed from the data.
 */
export function barsH(
  host: HTMLElement,
  data: Point[],
  opts: {
    rowH?: number; labelW?: number; fmt?: (v: number) => string; max?: number;
    onSelect?: (p: Point, i: number) => void; colour?: (p: Point, i: number) => string;
  } = {},
) {
  const rowH = opts.rowH ?? 22;
  const H = data.length * rowH + 22;
  const { svg, W } = frame(host, H);
  const mL = Math.min(opts.labelW ?? 130, Math.round(W * 0.46));
  const mR = W < 460 ? 54 : 66;
  const iw = Math.max(40, W - mL - mR);
  const fmt = opts.fmt ?? compact;

  const maxPos = Math.max(0, ...data.map((d) => d.value));
  const maxNeg = Math.max(0, ...data.map((d) => -d.value));
  const signed = maxNeg > 0;
  // Split the track between the negative and positive halves, keeping each side
  // at least a third so neither collapses when the data is lopsided.
  const zFrac = signed
    ? Math.min(0.7, Math.max(0.3, maxNeg / (maxNeg + maxPos || 1)))
    : 0;
  const zX = mL + (signed ? zFrac * iw : 0);
  const declared = opts.max ?? niceMax(Math.max(maxPos, maxNeg, 1));
  const xPos = scale(0, declared, zX, mL + iw);
  const xNeg = scale(0, signed ? Math.max(maxNeg, (maxPos / Math.max(1, mL + iw - zX)) * (zX - mL) || maxNeg) : declared, zX, mL);
  const xOf = (v: number) => (v >= 0 ? xPos(v) : xNeg(-v));

  if (signed) {
    svg.append(s('line', { x1: zX, x2: zX, y1: 4, y2: data.length * rowH + 4, stroke: 'var(--rule-strong)', 'stroke-width': 1 }));
  }

  data.forEach((d, i) => {
    const yy = 8 + i * rowH;
    if (i % 2 === 0) svg.append(s('rect', { x: mL, y: yy, width: iw, height: rowH - 1, fill: 'var(--ink)', 'fill-opacity': 0.022 }));
    const maxCh = Math.max(7, Math.floor((mL - 10) / 5.3));
    const shown = d.label.length > maxCh ? d.label.slice(0, maxCh - 1) + '…' : d.label;
    const lab = s('text', {
      x: mL - 8, y: yy + rowH / 2 + 3.5, 'text-anchor': 'end', 'font-size': 10.5, fill: 'var(--ink-2)',
    }, [shown]);
    lab.append(s('title', {}, [d.label]));
    svg.append(lab);

    const end = xOf(d.value);
    svg.append(s('rect', {
      x: Math.min(zX, end), y: yy + rowH / 2 - 4, width: Math.max(1, Math.abs(end - zX)), height: 8,
      fill: opts.colour ? opts.colour(d, i) : 'var(--ink)', 'fill-opacity': 0.8,
    }));
    svg.append(s('text', {
      x: W - 4, y: yy + rowH / 2 + 3.5, 'text-anchor': 'end', 'font-size': 10, fill: 'var(--ink-3)',
    }, [fmt(d.value)]));
    if (opts.onSelect) {
      const hit = s('rect', { x: 0, y: yy, width: W, height: rowH, fill: 'transparent', style: 'cursor:pointer' });
      hit.addEventListener('click', () => opts.onSelect!(d, i));
      svg.append(hit);
    }
  });
  mount(host, svg);
}

/** Two-series comparison on one shared axis — the controlled/naive figure. */
export function compareSeries(
  host: HTMLElement,
  xs: string[],
  series: { label: string; values: (number | null)[]; colour: string; dash?: string; mark: 'square' | 'circle'; band?: [number, number][] }[],
  opts: { height?: number; centre?: number; bands?: { lo: (number | null)[]; hi: (number | null)[]; colour: string } } = {},
) {
  const H = opts.height ?? 230;
  const { svg, W } = frame(host, H);
  const mL = 46, mR = 74, mT = 20, mB = 46;
  const iw = W - mL - mR, ih = H - mT - mB;
  const all = series.flatMap((sr) => sr.values).filter((v): v is number => v != null);
  const centre = opts.centre ?? 1;
  const spread = Math.max(0.04, ...all.map((v) => Math.abs(v - centre))) * 1.1;
  const lo = centre - spread, hi = centre + spread;
  const x = scale(0, Math.max(1, xs.length - 1), mL, mL + iw);
  const y = scale(lo, hi, mT + ih, mT);

  if (opts.bands) {
    const pts: number[] = [];
    opts.bands.hi.forEach((v, i) => { if (v != null) pts.push(x(i), y(v)); });
    const back: number[] = [];
    for (let i = opts.bands.lo.length - 1; i >= 0; i--) {
      const v = opts.bands.lo[i];
      if (v != null) back.push(x(i), y(v));
    }
    if (pts.length) svg.append(s('path', { d: linePath(pts) + linePath(back) + 'Z', fill: opts.bands.colour, 'fill-opacity': 0.12, stroke: 'none' }));
  }

  svg.append(s('line', { x1: mL, x2: mL + iw, y1: y(centre), y2: y(centre), stroke: 'var(--rule-strong)', 'stroke-width': 1 }));
  svg.append(tick(mL + iw + 6, y(centre) + 3.5, 'no effect', 'start', 9.5));
  for (const t of ticks(lo, hi, 4)) {
    if (Math.abs(t - centre) < 1e-9) continue;
    svg.append(s('line', { x1: mL, x2: mL + iw, y1: y(t), y2: y(t), stroke: 'var(--rule)', 'stroke-width': 1 }));
    svg.append(tick(mL - 7, y(t) + 3.5, two(t), 'end'));
  }

  for (const sr of series) {
    const pts: number[] = [];
    sr.values.forEach((v, i) => { if (v != null) pts.push(x(i), y(v)); });
    svg.append(s('path', {
      d: linePath(pts), fill: 'none', stroke: sr.colour, 'stroke-width': sr.dash ? 1.5 : 1.9,
      'stroke-dasharray': sr.dash,
    }));
    sr.values.forEach((v, i) => {
      if (v == null) return;
      if (sr.mark === 'square') svg.append(s('rect', { x: x(i) - 3, y: y(v) - 3, width: 6, height: 6, fill: 'var(--panel)', stroke: sr.colour, 'stroke-width': 1.5 }));
      else svg.append(s('circle', { cx: x(i), cy: y(v), r: 3.3, fill: sr.colour }));
    });
  }

  xs.forEach((lab, i) => {
    svg.append(tick(x(i), mT + ih + 15, lab, 'middle', 9.5));
  });
  mount(host, svg);
}

/** 7 x 24 heatmap. Sequential wash in ink; the peak cell is called out. */
export function heatmap(
  host: HTMLElement,
  mat: number[][],
  opts: { rowLabels: string[]; colStep?: number; onSelect?: (d: number, h: number) => void; highlight?: (d: number, h: number) => boolean },
) {
  const rowH = 26, mL = 40, mR = 8, mT = 14, mB = 20;
  const H = mT + mat.length * rowH + mB;
  const { svg, W } = frame(host, H);
  const iw = W - mL - mR;
  const cw = iw / 24;
  const max = Math.max(...mat.flat(), 1);
  const step = opts.colStep ?? (W < 560 ? 6 : 2);

  mat.forEach((row, d) => {
    const yy = mT + d * rowH;
    svg.append(s('text', { x: mL - 7, y: yy + rowH / 2 + 3.5, 'text-anchor': 'end', 'font-size': 10, fill: 'var(--ink-3)' }, [opts.rowLabels[d]]));
    row.forEach((v, h) => {
      const on = opts.highlight?.(d, h) ?? false;
      const cell = s('rect', {
        x: mL + h * cw, y: yy, width: Math.max(1, cw - 1), height: rowH - 2,
        fill: 'var(--ink)', 'fill-opacity': 0.06 + 0.86 * (v / max),
        stroke: on ? 'var(--rain)' : undefined, 'stroke-width': on ? 1.5 : undefined,
      });
      (cell as SVGRectElement).style.cursor = 'pointer';
      cell.append(s('title', {}, [`${opts.rowLabels[d]} ${String(h).padStart(2, '0')}:00 — ${int(v)} trips/hour`]));
      if (opts.onSelect) cell.addEventListener('click', () => opts.onSelect!(d, h));
      svg.append(cell);
    });
  });
  for (let h = 0; h < 24; h += step) {
    svg.append(tick(mL + h * cw + cw / 2, mT + mat.length * rowH + 13, String(h).padStart(2, '0'), 'middle', 9));
  }
  mount(host, svg);
}

/** Horizontal histogram for a continuous variable. */
export function histogram(
  host: HTMLElement,
  values: number[],
  opts: { bins?: number; lo?: number; hi?: number; height?: number; unit?: string; label?: string; colour?: string },
) {
  const H = opts.height ?? 150;
  const { svg, W } = frame(host, H);
  const mL = 40, mR = 12, mT = 14, mB = 30;
  const iw = W - mL - mR, ih = H - mT - mB;
  const lo = opts.lo ?? Math.min(...values);
  const hi = opts.hi ?? Math.max(...values);
  const nb = opts.bins ?? 24;
  const counts = new Array(nb).fill(0);
  for (const v of values) {
    const i = Math.min(nb - 1, Math.max(0, Math.floor(((v - lo) / (hi - lo || 1)) * nb)));
    counts[i]++;
  }
  const max = niceMax(Math.max(...counts, 1), 3);
  const y = scale(0, max, mT + ih, mT);
  const bw = iw / nb;
  for (const t of ticks(0, max, 3)) {
    svg.append(s('line', { x1: mL, x2: mL + iw, y1: y(t), y2: y(t), stroke: 'var(--rule)', 'stroke-width': 1 }));
    svg.append(tick(mL - 7, y(t) + 3.5, compact(t), 'end'));
  }
  counts.forEach((c, i) => {
    const top = y(c);
    svg.append(s('rect', {
      x: mL + i * bw + 0.5, y: top, width: Math.max(1, bw - 1), height: Math.max(0.8, mT + ih - top),
      fill: opts.colour ?? 'var(--ink)', 'fill-opacity': 0.72,
    }));
  });
  svg.append(s('line', { x1: mL, x2: mL + iw, y1: mT + ih, y2: mT + ih, stroke: 'var(--rule-ink)', 'stroke-width': 1 }));
  for (const t of ticks(lo, hi, 4)) {
    svg.append(tick(mL + ((t - lo) / (hi - lo || 1)) * iw, mT + ih + 13, one(t), 'middle', 9.5));
  }
  if (opts.label) svg.append(s('text', { x: mL + iw, y: mT - 3, 'text-anchor': 'end', 'font-size': 9, fill: 'var(--ink-3)' }, [opts.label]));
  mount(host, svg);
}

/** Scatter of hourly temperature against trips, with a binned median line. */
export function scatter(
  host: HTMLElement,
  pts: { x: number; y: number; kind: string }[],
  opts: { height?: number; xLabel?: string; yLabel?: string },
) {
  const H = opts.height ?? 240;
  const { svg, W } = frame(host, H);
  const mL = 48, mR = 14, mT = 16, mB = 34;
  const iw = W - mL - mR, ih = H - mT - mB;
  const xv = pts.map((p) => p.x), yv = pts.map((p) => p.y);
  const xlo = Math.min(...xv), xhi = Math.max(...xv);
  const yhi = niceMax(Math.max(...yv), 4);
  const xd = scale(xlo, xhi, mL, mL + iw);
  const yd = scale(0, yhi, mT + ih, mT);

  for (const t of ticks(0, yhi, 4)) {
    svg.append(s('line', { x1: mL, x2: mL + iw, y1: yd(t), y2: yd(t), stroke: 'var(--rule)', 'stroke-width': 1 }));
    svg.append(tick(mL - 7, yd(t) + 3.5, compact(t), 'end'));
  }
  const shade: Record<string, string> = { dry: 'var(--ink)', rain: 'var(--rain)', snow: 'var(--frost)' };
  for (const p of pts) {
    svg.append(s('circle', {
      cx: xd(p.x), cy: yd(p.y), r: p.kind === 'snow' ? 2.6 : 1.9,
      fill: shade[p.kind] ?? 'var(--ink)', 'fill-opacity': p.kind === 'dry' ? 0.16 : 0.62,
    }));
  }
  // binned median
  const nb = 16, acc: number[][] = Array.from({ length: nb }, () => []);
  for (const p of pts) {
    const i = Math.min(nb - 1, Math.max(0, Math.floor(((p.x - xlo) / (xhi - xlo || 1)) * nb)));
    acc[i].push(p.y);
  }
  const med: number[] = [];
  acc.forEach((a, i) => {
    if (!a.length) return;
    a.sort((p, q) => p - q);
    med.push(xd(xlo + ((i + 0.5) / nb) * (xhi - xlo)), yd(a[Math.floor(a.length / 2)]));
  });
  if (med.length > 2) svg.append(s('path', { d: linePath(med), fill: 'none', stroke: 'var(--ink)', 'stroke-width': 1.8 }));
  for (const t of ticks(xlo, xhi, 4)) svg.append(tick(xd(t), mT + ih + 14, one(t), 'middle', 9.5));
  if (opts.xLabel) svg.append(s('text', { x: mL + iw / 2, y: H - 3, 'text-anchor': 'middle', 'font-size': 9.5, fill: 'var(--ink-3)', 'letter-spacing': '0.06em' }, [opts.xLabel]));
  if (opts.yLabel) svg.append(s('text', { x: mL - 7, y: mT - 4, 'text-anchor': 'end', 'font-size': 9, fill: 'var(--ink-3)' }, [opts.yLabel]));
  mount(host, svg);
}

/** Cumulative concentration curve with the 10/50 zone marks. */
export function concentration(host: HTMLElement, points: { n: number; share: number }[], opts: { height?: number } = {}) {
  const H = opts.height ?? 180;
  const { svg, W } = frame(host, H);
  const mL = 42, mR = 44, mT = 16, mB = 30;
  const iw = W - mL - mR, ih = H - mT - mB;
  const x = scale(0, points.length, mL, mL + iw);
  const y = scale(0, 100, mT + ih, mT);
  for (const t of [0, 25, 50, 75, 100]) {
    svg.append(s('line', { x1: mL, x2: mL + iw, y1: y(t), y2: y(t), stroke: t === 0 ? 'var(--rule-strong)' : 'var(--rule)', 'stroke-width': 1 }));
    svg.append(tick(mL - 7, y(t) + 3.5, t + '%', 'end'));
  }
  const pts: number[] = [x(0), y(0)];
  for (const p of points) pts.push(x(p.n), y(p.share));
  svg.append(s('path', { d: areaPath(pts, mT + ih), fill: 'var(--ink)', 'fill-opacity': 0.1, stroke: 'none' }));
  svg.append(s('path', { d: linePath(pts), fill: 'none', stroke: 'var(--ink)', 'stroke-width': 1.9 }));
  for (const [mark, dy, anchor] of [[10, -8, 'start'], [50, 13, 'middle']] as [number, number, string][]) {
    const p = points[Math.min(mark, points.length) - 1];
    if (!p) continue;
    svg.append(s('line', { x1: x(p.n), x2: x(p.n), y1: y(p.share), y2: mT + ih, stroke: 'var(--rule-strong)', 'stroke-width': 1, 'stroke-dasharray': '2 2' }));
    svg.append(s('circle', { cx: x(p.n), cy: y(p.share), r: 3.2, fill: 'var(--ink)' }));
    svg.append(s('text', {
      x: x(p.n) + (anchor === 'start' ? 5 : 0), y: y(p.share) + dy, 'text-anchor': anchor,
      'font-size': 9.5, fill: 'var(--ink)', 'font-weight': 700,
    }, [`${mark} zones = ${p.share.toFixed(1)}%`]));
  }
  svg.append(tick(mL + iw / 2, H - 3, 'ZONES, RANKED BY TRIPS', 'middle', 9.5));
  mount(host, svg);
}

/* ------------------------------------------------------------------- table -- */

export interface Column<T> {
  key: string;
  label: string;
  align?: 'left' | 'right';
  fmt?: (v: unknown, row: T) => string;
  bar?: (row: T) => number;
  cls?: string;
  sortable?: boolean;
}

export function table<T extends Record<string, unknown>>(
  host: HTMLElement,
  rows: T[],
  cols: Column<T>[],
  opts: {
    onRow?: (row: T) => void;
    isOn?: (row: T) => boolean;
    sort?: { key: string; dir: 1 | -1 };
    onSort?: (key: string) => void;
    caption?: string;
    state?: { key: string; dir: 1 | -1 };
  } = {},
) {
  clear(host);
  const wrap = document.createElement('div');
  wrap.className = rows.length > 26 ? 'tablewrap tablewrap--tall' : 'tablewrap';
  const t = document.createElement('table');
  t.className = 'dtable';
  const tall = rows.length > 26;
  if (opts.caption) {
    const c = document.createElement('caption');
    c.className = 'visually-hidden';
    c.textContent = opts.caption + (tall ? ` ${rows.length} rows; the table scrolls.` : '');
    t.append(c);
  }
  const thead = document.createElement('thead');
  const trh = document.createElement('tr');
  for (const c of cols) {
    const th = document.createElement('th');
    th.style.textAlign = c.align ?? 'right';
    if (c.sortable && opts.onSort) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'sort' + (opts.sort?.key === c.key ? ' is-on' : '');
      b.textContent = c.label + (opts.sort?.key === c.key ? (opts.sort.dir === -1 ? ' ↓' : ' ↑') : '');
      b.addEventListener('click', () => opts.onSort!(c.key));
      th.append(b);
    } else {
      th.textContent = c.label;
    }
    trh.append(th);
  }
  thead.append(trh);
  t.append(thead);

  const tbody = document.createElement('tbody');
  const maxBar = Math.max(...rows.map((r) => Math.max(...cols.filter((c) => c.bar).map((c) => c.bar!(r)))), 1);
  for (const r of rows) {
    const tr = document.createElement('tr');
    if (opts.isOn?.(r)) tr.classList.add('is-on');
    if (opts.onRow) {
      tr.tabIndex = 0;
      tr.setAttribute('role', 'button');
      tr.addEventListener('click', () => opts.onRow!(r));
      tr.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); opts.onRow!(r); }
      });
    }
    for (const c of cols) {
      const td = document.createElement('td');
      td.className = [c.align === 'left' ? '' : 'num', c.cls ?? ''].join(' ').trim();
      const raw = r[c.key];
      if (c.bar) {
        const w = document.createElement('div');
        w.className = 'minibar';
        const f = document.createElement('span');
        f.style.width = `${(c.bar(r) / maxBar) * 100}%`;
        w.append(f);
        td.append(w);
      } else {
        td.textContent = c.fmt ? c.fmt(raw, r) : String(raw ?? '');
      }
      tr.append(td);
    }
    tbody.append(tr);
  }
  t.append(tbody);
  wrap.append(t);
  host.append(wrap);
  if (tall) {
    const hint = document.createElement('p');
    hint.className = 'tablehint';
    hint.textContent = `${rows.length} rows — scroll inside the table for the rest.`;
    host.append(hint);
  }
}

/** A ruled strip of headline figures — a table of numbers, not hero cards. */
export function kpiStrip(host: HTMLElement, items: { label: string; value: string; note?: string; colour?: string }[]) {
  clear(host);
  const dl = document.createElement('dl');
  dl.className = 'kpis';
  for (const it of items) {
    const d = document.createElement('div');
    d.className = 'kpi';
    if (it.colour) d.style.setProperty('--kpi-c', it.colour);
    const dt = document.createElement('dt');
    dt.textContent = it.label;
    const dd = document.createElement('dd');
    dd.className = 'num';
    dd.textContent = it.value;
    d.append(dt, dd);
    if (it.note) {
      const n = document.createElement('p');
      n.className = 'kpi__note';
      n.textContent = it.note;
      d.append(n);
    }
    dl.append(d);
  }
  host.append(dl);
}

export function legend(host: HTMLElement, items: { swatch: 'line' | 'bar' | 'dot' | 'ring' | 'wash' | 'sq'; colour: string; label: string; note?: string }[]) {
  clear(host);
  const ul = document.createElement('ul');
  ul.className = 'legend';
  for (const it of items) {
    const li = document.createElement('li');
    const sw = document.createElement('span');
    sw.className = `legend__sw legend__sw--${it.swatch}`;
    sw.style.setProperty('--sw', it.colour);
    const tx = document.createElement('span');
    tx.innerHTML = it.label + (it.note ? ` <i>${it.note}</i>` : '');
    li.append(sw, tx);
    ul.append(li);
  }
  host.append(ul);
}

/** A panel is a ruled block with a label, a title and a source note. */
export function panel(host: HTMLElement, opts: { title: string; label?: string; note?: string; wide?: boolean }): HTMLElement {
  const wrap = document.createElement('section');
  wrap.className = 'panel' + (opts.wide ? ' panel--wide' : '');
  const head = document.createElement('div');
  head.className = 'panel__head';
  if (opts.label) {
    const l = document.createElement('span');
    l.className = 'fig-label';
    l.textContent = opts.label;
    head.append(l);
  }
  const h = document.createElement('h2');
  h.className = 'panel__h';
  h.textContent = opts.title;
  head.append(h);
  const body = document.createElement('div');
  body.className = 'panel__body';
  wrap.append(head, body);
  if (opts.note) {
    const n = document.createElement('p');
    n.className = 'panel__note';
    n.innerHTML = opts.note;
    wrap.append(n);
  }
  host.append(wrap);
  return body;
}
