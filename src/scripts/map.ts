/* The choropleth. Geometry comes from the official TLC zone file; values come
   from /api/zones under the current lens. Projected with a cos(lat) correction so
   the city is not stretched, then drawn as one path per zone. */

import { mount, s } from './charts';

interface Feature {
  properties: { locationid: string; zone: string; borough: string };
  geometry: { type: string; coordinates: any };
}

export type Metric = 'trips' | 'dropoffs' | 'net' | 'revenue' | 'amount' | 'distance' | 'rainIndex' | 'snowIndex';

export const METRICS: { key: Metric; label: string; fmt: (v: number) => string; diverging?: boolean; log?: boolean; note: string }[] = [
  { key: 'trips', label: 'Pickups', log: true, fmt: (v) => Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(v), note: 'trips that started in each zone, shaded on a logarithmic scale so small zones stay legible next to JFK' },
  { key: 'dropoffs', label: 'Dropoffs', log: true, fmt: (v) => Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(v), note: 'trips that ended in each zone — the destination side of the same trip set' },
  { key: 'net', label: 'Net flow', diverging: true, fmt: (v) => (v >= 0 ? '+' : '−') + Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(Math.abs(v)), note: 'pickups minus dropoffs. Blue absorbs people, red emits them' },
  { key: 'revenue', label: 'Revenue', log: true, fmt: (v) => '$' + Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(v), note: 'total revenue in the current lens, shaded on a logarithmic scale' },
  { key: 'amount', label: '$ / trip', fmt: (v) => '$' + v.toFixed(2), note: 'mean total amount per trip' },
  { key: 'distance', label: 'Miles', fmt: (v) => v.toFixed(2) + ' mi', note: 'mean trip distance' },
  { key: 'rainIndex', label: 'Rain index', fmt: (v) => v.toFixed(3), diverging: true, note: 'share of wet-hour trips ÷ share of dry-hour trips; 1.000 is no change' },
  { key: 'snowIndex', label: 'Snow index', fmt: (v) => v.toFixed(3), diverging: true, note: 'share of snowing-hour trips ÷ share of dry-hour trips' },
];

/* A local equirectangular projection. Longitude is compressed by cos(latitude)
   so the five boroughs are not stretched sideways, which at 40.7° N is a 24%
   correction — enough that skipping it makes the city look wrong. */
const proj = (() => {
  let lon0 = -74.26, lat1 = 40.92, k = 1, ox = 0, oy = 0, cosLat = 0.758;
  return {
    fit(features: Feature[], W: number, H: number) {
      let minLon = 1e9, maxLon = -1e9, minLat = 1e9, maxLat = -1e9;
      const visit = (c: any) => {
        if (typeof c[0] === 'number') {
          if (c[0] < minLon) minLon = c[0];
          if (c[0] > maxLon) maxLon = c[0];
          if (c[1] < minLat) minLat = c[1];
          if (c[1] > maxLat) maxLat = c[1];
        } else for (const x of c) visit(x);
      };
      for (const f of features) visit(f.geometry.coordinates);
      const midLat = (minLat + maxLat) / 2;
      cosLat = Math.cos((midLat * Math.PI) / 180);
      const spanX = (maxLon - minLon) * cosLat;
      const spanY = maxLat - minLat;
      k = Math.min(W / spanX, H / spanY) * 0.97;
      lon0 = minLon;
      lat1 = maxLat;
      ox = (W - spanX * k) / 2;
      oy = (H - spanY * k) / 2;
    },
    x: (lon: number) => ox + (lon - lon0) * cosLat * k,
    y: (lat: number) => oy + (lat1 - lat) * k,
  };
})();

function ringPath(rings: number[][][], close = true): string {
  let d = '';
  for (const ring of rings) {
    ring.forEach((pt, i) => {
      d += (i === 0 ? 'M' : 'L') + proj.x(pt[0]).toFixed(1) + ' ' + proj.y(pt[1]).toFixed(1);
    });
    if (close) d += 'Z';
  }
  return d;
}

function featurePath(f: Feature): string {
  const g = f.geometry;
  if (g.type === 'Polygon') return ringPath(g.coordinates as number[][][]);
  if (g.type === 'MultiPolygon') {
    return (g.coordinates as number[][][][]).map((poly) => ringPath(poly)).join('');
  }
  return '';
}

/** Sequential ramp in ink; diverging ramp in rain-blue / alert for indices. */
export function ramp(stops: string[], n = 24): string[] {
  const out: string[] = [];
  const hex = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const seg = Math.min(stops.length - 2, Math.floor(t * (stops.length - 1)));
    const lt = t * (stops.length - 1) - seg;
    const a = hex(stops[seg]), b = hex(stops[seg + 1]);
    out.push('#' + a.map((v, j) => Math.round(v + (b[j] - v) * lt).toString(16).padStart(2, '0')).join(''));
  }
  return out;
}

export interface MapHandle {
  setMetric(m: Metric, values: Map<number, number>): void;
  select(id: number | null): void;
  zoomTo(id: number): void;
  zoomBy(factor: number, about?: { x: number; y: number }): void;
  reset(): void;
  scale(): number;
  /** Subscribe to view changes, so a control readout cannot go stale. */
  onView(fn: (k: number) => void): void;
  featureCount(): number;
}

export async function buildMap(
  host: HTMLElement,
  opts: { onSelect: (id: number) => void; getName: (id: number) => string },
): Promise<MapHandle> {
  const geo = await fetch('/geo/taxi_zones.geojson').then((r) => r.json());
  const features: Feature[] = geo.features;
  const W = 720, H = 700;
  proj.fit(features, W, H);

  const svg = s('svg', {
    viewBox: `0 0 ${W} ${H}`, class: 'map', role: 'img',
    'aria-label': 'New York City taxi zones, shaded by the selected measure. Each zone is keyboard-selectable from the ranking table.',
  });
  const g = s('g', { id: 'zones' });
  const paths = new Map<number, SVGPathElement>();
  const boxes = new Map<number, [number, number, number, number]>();
  for (const f of features) {
    const id = Number(f.properties.locationid);
    const d = featurePath(f);
    if (!d) continue;
    // the zone's own bounding box, in projected space, for zoom-to-zone
    let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    const visit = (c: any) => {
      if (typeof c[0] === 'number') {
        const X = proj.x(c[0]), Y = proj.y(c[1]);
        if (X < x0) x0 = X;
        if (X > x1) x1 = X;
        if (Y < y0) y0 = Y;
        if (Y > y1) y1 = Y;
      } else for (const k of c) visit(k);
    };
    visit(f.geometry.coordinates);
    if (x1 > x0) boxes.set(id, [x0, y0, x1, y1]);
    const p = s('path', { d, fill: 'var(--sunken)' }) as SVGPathElement;
    p.dataset.id = String(id);
    p.append(s('title', {}, [`${f.properties.zone}, ${f.properties.borough}`]));
    p.addEventListener('click', () => opts.onSelect(id));
    p.addEventListener('pointerenter', () => {
      const tip = host.parentElement?.querySelector('.map__tip') as HTMLElement | null;
      if (!tip) return;
      const v = p.dataset.v;
      tip.innerHTML = `<b>${f.properties.zone}</b>${v ? ` · ${v}` : ''}<br>${f.properties.borough} · zone ${id}`;
      const r = p.getBoundingClientRect();
      const pr = host.parentElement!.getBoundingClientRect();
      tip.style.left = r.left - pr.left + r.width / 2 + 'px';
      tip.style.top = r.top - pr.top + 'px';
      tip.classList.add('is-on');
    });
    p.addEventListener('pointerleave', () => {
      const tip = host.parentElement?.querySelector('.map__tip') as HTMLElement | null;
      tip?.classList.remove('is-on');
    });
    paths.set(id, p);
    g.append(p);
  }
  svg.append(g);
  mount(host, svg);

  let seq = ramp(['#dfe3e1', '#7d868b', '#141a1f'], 24);
  let div = ramp(['#a8261c', '#e9eae8', '#2c62d6'], 24);

  /* The view is two numbers — a translate and a scale applied to one group — so
     clicking, scrolling and dragging all move the same state. */
  const view = { x: 0, y: 0, k: 1 };
  const viewWatchers: ((k: number) => void)[] = [];
  const apply = () => {
    g.setAttribute('transform', `translate(${view.x.toFixed(2)} ${view.y.toFixed(2)}) scale(${view.k.toFixed(4)})`);
    for (const fn of viewWatchers) fn(view.k);
  };
  apply();

  const clampK = (k: number) => Math.max(1, Math.min(14, k));

  /** Zoom about a point given in the SVG's own coordinate system. */
  const zoomAbout = (factor: number, cx: number, cy: number) => {
    const k2 = clampK(view.k * factor);
    if (k2 === view.k) return;
    const r = k2 / view.k;
    view.x = cx - r * (cx - view.x);
    view.y = cy - r * (cy - view.y);
    view.k = k2;
    if (view.k <= 1.001) { view.x = 0; view.y = 0; view.k = 1; }
    apply();
  };

  const svgPoint = (e: { clientX: number; clientY: number }) => {
    const b = svg.getBoundingClientRect();
    return { x: ((e.clientX - b.left) / b.width) * W, y: ((e.clientY - b.top) / b.height) * H };
  };

  svg.addEventListener('wheel', (e) => {
    e.preventDefault();
    const p = svgPoint(e);
    zoomAbout(e.deltaY < 0 ? 1.14 : 1 / 1.14, p.x, p.y);
  }, { passive: false });

  let drag: { x: number; y: number; vx: number; vy: number; moved: boolean } | null = null;
  svg.addEventListener('pointerdown', (e) => {
    if ((e.target as Element).tagName !== 'path') return;
    drag = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y, moved: false };
    svg.setPointerCapture(e.pointerId);
  });
  svg.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const b = svg.getBoundingClientRect();
    const dx = ((e.clientX - drag.x) / b.width) * W;
    const dy = ((e.clientY - drag.y) / b.height) * H;
    if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
    if (drag.moved) { view.x = drag.vx + dx; view.y = drag.vy + dy; apply(); }
  });
  const endDrag = (e: PointerEvent) => {
    if (drag) svg.releasePointerCapture?.(e.pointerId);
    if (drag?.moved) svg.dataset.dragged = '1';
    drag = null;
  };
  svg.addEventListener('pointerup', endDrag);
  svg.addEventListener('pointercancel', endDrag);
  // a pan must not also register as a click-select
  svg.addEventListener('click', (e) => {
    if (svg.dataset.dragged === '1') { delete svg.dataset.dragged; e.stopPropagation(); }
  }, true);

  return {
    featureCount: () => paths.size,
    select(id) {
      for (const [, p] of paths) p.classList.remove('is-on');
      if (id != null) {
        paths.get(id)?.classList.add('is-on');
        g.classList.add('has-sel');
      } else {
        g.classList.remove('has-sel');
      }
    },
    /** Centre and scale the city onto one zone, so the detail panel has context. */
    zoomTo(id) {
      const b = boxes.get(id);
      if (!b) { view.x = 0; view.y = 0; view.k = 1; apply(); return; }
      const [x0, y0, x1, y1] = b;
      const pad = 62;
      const bw = Math.max(24, x1 - x0), bh = Math.max(24, y1 - y0);
      const k = clampK(Math.min((W - pad * 2) / bw, (H - pad * 2) / bh, 7));
      const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
      view.k = k;
      view.x = W / 2 - cx * k;
      view.y = H / 2 - cy * k;
      apply();
    },
    zoomBy(factor, about) {
      const p = about ?? { x: W / 2, y: H / 2 };
      zoomAbout(factor, p.x, p.y);
    },
    reset() { view.x = 0; view.y = 0; view.k = 1; apply(); },
    scale: () => view.k,
    onView(fn) { viewWatchers.push(fn); fn(view.k); },
    setMetric(m, values) {
      const meta = METRICS.find((x) => x.key === m)!;
      const raw = [...values.values()].filter((x) => Number.isFinite(x));
      const vals = raw.filter((x) => x > 0);
      const max = vals.length ? Math.max(...vals) : 1;
      const maxAbs = raw.length ? Math.max(...raw.map((x) => Math.abs(x)), 1) : 1;
      const logMax = Math.log10(max + 1);
      const colour = (v: number) => {
        if (meta.diverging) {
          const span = meta.key === 'net' ? maxAbs : 0.09;
          const centred = meta.key === 'net' ? v : v - 1;
          const t = (centred / span + 1) / 2;
          return div[Math.max(0, Math.min(div.length - 1, Math.round(t * (div.length - 1))))];
        }
        // A linear ramp on a heavy-tailed count makes 250 zones one shade.
        const t = meta.log ? Math.log10(Math.max(v, 0) + 1) / logMax : v / max;
        return seq[Math.max(0, Math.min(seq.length - 1, Math.round(t * (seq.length - 1))))];
      };
      for (const [id, p] of paths) {
        const v = values.get(id);
        if (v == null || !Number.isFinite(v)) {
          p.setAttribute('fill', 'var(--sunken)');
          p.classList.add('is-unmapped');
          delete p.dataset.v;
        } else {
          p.setAttribute('fill', colour(v));
          p.classList.remove('is-unmapped');
          p.dataset.v = meta.fmt(v);
        }
      }
      void div; void seq;
    },
  };
}

/**
 * A small control cluster for the map. Click-to-zoom with no way back is a trap,
 * so the controls are always present: in, out, and reset to the whole city.
 */
export function mapControls(wrap: HTMLElement, handle: MapHandle, onSelect?: () => void) {
  wrap.querySelector('.mapctl')?.remove();
  const box = document.createElement('div');
  box.className = 'mapctl';
  box.setAttribute('role', 'group');
  box.setAttribute('aria-label', 'Map zoom');

  const mk = (label: string, title: string, fn: () => void) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'mapctl__btn';
    b.textContent = label;
    b.title = title;
    b.setAttribute('aria-label', title);
    b.addEventListener('click', fn);
    return b;
  };

  box.append(
    mk('+', 'Zoom in', () => handle.zoomBy(1.45)),
    mk('−', 'Zoom out', () => handle.zoomBy(1 / 1.45)),
    mk('⤢', 'Fit the whole city', () => { handle.reset(); onSelect?.(); }),
  );

  // The level readout is driven by the map itself, not by the buttons, so a
  // programmatic zoom-to-zone keeps it honest.
  const lvl = document.createElement('span');
  lvl.className = 'mapctl__lvl';
  handle.onView((k) => { lvl.textContent = k.toFixed(1) + '×'; });
  box.append(lvl);

  wrap.append(box);
}

export function rampStops(m: Metric): string[] {
  const meta = METRICS.find((x) => x.key === m)!;
  return meta.diverging ? ['#a8261c', '#e9eae8', '#2c62d6'] : ['#dfe3e1', '#7d868b', '#141a1f'];
}
