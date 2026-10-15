/* The year trace. All 8,759 recorded hours drawn individually as a faint fabric,
   the daily mean in ink over the top, temperature as a dotted line on its own
   right-hand scale, and daily precipitation hanging from the shared baseline,
   capped where snow fell. This is the thesis panel, so it draws everything. */

import { frame, linePath, mount, niceMax, scale, s, tick, ticks } from './charts';

export interface HourRec {
  mon: number; hod: number; doy: number; dow: number;
  trips: number; revenue: number; kind: string; code: number;
  temp: number; precip: number; snow: number;
}

export function drawYear(host: HTMLElement, recs: HourRec[]) {
  const W = Math.max(280, Math.floor(host.clientWidth || 640));
  const H = 306;
  const mL = 48, mR = 56, mT = 18, mB = 42;
  const rainH = Math.round(H * 0.3);
  const plotH = H - mT - mB - rainH;
  const iw = W - mL - mR;
  const baseY = mT + plotH;

  const svg = s('svg', {
    width: '100%', viewBox: `0 0 ${W} ${H}`, height: H, role: 'img',
    'aria-label': `Hourly New York taxi trips across 2025 — ${recs.length} recorded hours. A heavy line traces the daily mean, a dotted line traces temperature, and bars below the baseline show daily rainfall.`,
  });

  const T = recs.map((r) => r.trips);
  const maxT = niceMax(Math.max(...T), 4);
  const tempLo = Math.min(...recs.map((r) => r.temp));
  const tempHi = Math.max(...recs.map((r) => r.temp));

  const xHour = scale(0, recs.length - 1, mL, mL + iw);
  const yT = scale(0, maxT, baseY, mT);
  const yTemp = scale(tempLo, tempHi, baseY, mT);
  // day-of-year -> x, taken from the first hour that day belongs to
  const dayX = new Float64Array(367);
  for (let i = 0; i < recs.length; i++) dayX[recs[i].doy] = xHour(i);

  // ---- month rules + y grid
  const MONTH_START = [1, 32, 60, 91, 121, 152, 182, 213, 244, 274, 305, 335];
  for (const d of MONTH_START) {
    svg.append(s('line', { x1: dayX[d], x2: dayX[d], y1: mT - 6, y2: baseY + rainH, stroke: 'var(--rule)', 'stroke-width': 1 }));
  }
  for (const t of ticks(0, maxT, 4)) {
    svg.append(s('line', { x1: mL, x2: mL + iw, y1: yT(t), y2: yT(t), stroke: 'var(--rule)', 'stroke-width': 1 }));
    svg.append(tick(mL - 7, yT(t) + 3.5, Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(t), 'end'));
  }

  // ---- the raw fabric of every hour
  const raw: number[] = [];
  for (let i = 0; i < recs.length; i++) raw.push(xHour(i), yT(recs[i].trips));
  svg.append(s('path', { d: linePath(raw), fill: 'none', stroke: 'var(--ink)', 'stroke-width': 0.5, 'stroke-opacity': 0.15 }));

  // ---- daily aggregates
  const dSum = new Float64Array(367), dCnt = new Int32Array(367);
  const dTemp = new Float64Array(367), dRain = new Float64Array(367);
  const dSnow = new Uint8Array(367);
  for (const r of recs) {
    dSum[r.doy] += r.trips; dCnt[r.doy]++;
    dTemp[r.doy] += r.temp; dRain[r.doy] += r.precip;
    if (r.snow > 0) dSnow[r.doy] = 1;
  }
  const meanPts: number[] = [], tempPts: number[] = [];
  for (let d = 1; d <= 365; d++) {
    if (!dCnt[d]) continue;
    meanPts.push(dayX[d], yT(dSum[d] / dCnt[d]));
    tempPts.push(dayX[d], yTemp(dTemp[d] / dCnt[d]));
  }
  svg.append(s('path', { d: linePath(tempPts), fill: 'none', stroke: 'var(--ink-3)', 'stroke-width': 1, 'stroke-opacity': 0.62, 'stroke-dasharray': '1.5 2.5' }));
  svg.append(s('path', { d: linePath(meanPts), fill: 'none', stroke: 'var(--ink)', 'stroke-width': 1.9, 'stroke-linejoin': 'round' }));

  // ---- shared baseline + daily rain
  svg.append(s('line', { x1: mL, x2: mL + iw, y1: baseY, y2: baseY, stroke: 'var(--rule-ink)', 'stroke-width': 1 }));
  const maxRain = niceMax(Math.max(...[...dRain].slice(1, 366)), 3);
  const yR = scale(0, maxRain, baseY, baseY + rainH);
  const bw = Math.max(1, iw / 365 - 0.5);
  for (let d = 1; d <= 365; d++) {
    const v = dRain[d];
    if (v <= 0) continue;
    const top = yR(v);
    svg.append(s('rect', {
      x: dayX[d] - bw / 2, y: baseY, width: bw, height: Math.max(1, top - baseY),
      fill: dSnow[d] ? 'var(--frost)' : 'var(--rain)', 'fill-opacity': dSnow[d] ? 0.95 : 0.72,
    }));
    if (dSnow[d]) {
      svg.append(s('line', {
        x1: dayX[d] - bw / 2 - 1, x2: dayX[d] + bw / 2 + 1, y1: baseY - 2.5, y2: baseY - 2.5,
        stroke: 'var(--frost)', 'stroke-width': 2, 'stroke-linecap': 'round',
      }));
    }
  }
  svg.append(tick(mL - 7, mT - 6, 'trips/h', 'end', 9));
  svg.append(s('text', { x: W - mR + 4, y: mT - 6, 'font-size': 9, fill: 'var(--ink-3)' }, [`temp ${Math.round(tempLo)}–${Math.round(tempHi)}°`]));
  svg.append(s('text', { x: W - mR + 4, y: baseY + rainH + 12, 'font-size': 9, fill: 'var(--ink-3)', 'text-anchor': 'end' }, ['mm/day']));

  const ML = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  ML.forEach((m, i) => {
    svg.append(s('text', {
      x: dayX[MONTH_START[i]] + 3, y: H - mB + 20, 'font-size': 9.5, 'font-weight': 600,
      fill: 'var(--ink-3)', 'letter-spacing': '0.07em',
    }, [m.toUpperCase()]));
  });

  mount(host, svg);
}
