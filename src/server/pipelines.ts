/**
 * Every number the dashboard shows comes from one of these pipelines, run by
 * mongod against the 976,425-row `trips` collection. The filter bar maps to a
 * single `$match`, so a change of lens is one query shape with different bounds.
 *
 * A note on counting hours. `trips` is one row per (hour x pickup zone), and a
 * zone only appears in an hour if it carried at least one trip, so the row count
 * is emphatically not the hour count. Every `hours` figure below is the size of
 * a `$addToSet` on the hour field. Getting this wrong inflates trips-per-hour by
 * roughly the mean number of active zones (about 112).
 */
import { col, cached } from './db';
import forecastData from '../data/forecast.json';

export interface Filter {
  mon: number | null;
  dow: number | null;
  hod: number | null;
  kind: 'all' | 'dry' | 'rain' | 'snow';
}

export const ALL: Filter = { mon: null, dow: null, hod: null, kind: 'all' };

export function parseFilter(u: URLSearchParams): Filter {
  const num = (k: string, lo: number, hi: number) => {
    const raw = u.get(k);
    if (raw == null || raw === '' || raw === 'all') return null;
    const n = Number(raw);
    return Number.isFinite(n) && n >= lo && n <= hi ? n : null;
  };
  const k = u.get('kind');
  return {
    mon: num('mon', 1, 12),
    dow: num('dow', 0, 6),
    hod: num('hod', 0, 23),
    kind: k === 'dry' || k === 'rain' || k === 'snow' ? k : 'all',
  };
}

export const filterKey = (f: Filter) =>
  `${f.mon ?? 'a'}-${f.dow ?? 'a'}-${f.hod ?? 'a'}-${f.kind}`;

/** The one `$match` every filtered pipeline begins with. */
export function matchStage(f: Filter): Record<string, unknown> {
  const m: Record<string, unknown> = {};
  if (f.mon != null) m['cal.mon'] = f.mon;
  if (f.dow != null) m['cal.dow'] = f.dow;
  if (f.hod != null) m['cal.hod'] = f.hod;
  if (f.kind !== 'all') m['weather.kind'] = f.kind;
  return { $match: m };
}

const round = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d;

/** Distinct-hour bookkeeping, used by every pipeline below. */
const HOURS = { _hours: { $addToSet: '$hour' } } as const;
const SIZE_HOURS = { $addFields: { hours: { $size: '$_hours' } } } as const;
const DROP_HOURS = { $project: { _hours: 0 } } as const;

/** Conditional distinct-hour count. The set is keyed on the condition, so the
 *  group `_id` never collides and the sentinel can never be mistaken for a date. */
function countWhere<T extends { k: boolean; h: unknown }>(set: T[] | undefined, want: boolean) {
  if (!Array.isArray(set)) return 0;
  return set.reduce((a, x) => a + (x.k === want ? 1 : 0), 0);
}

export interface Summary {
  trips: number; dropoffs: number; net: number; revenue: number; revenuePerTrip: number;
  farePerTrip: number; tipPerTrip: number; tipPct: number;
  distance: number; duration: number; passengers: number;
  hours: number; zones: number; tripsPerHour: number; revenuePerHour: number;
  meanTemp: number; meanPrecip: number; wetHours: number;
  peakHour: { hod: number; trips: number } | null;
  topZone: { id: number; name: string; borough: string; trips: number; revenue: number } | null;
}

/** Headline figures for the current lens. One $group, then zone names resolved. */
export function summary(f: Filter) {
  return cached(`summary:${filterKey(f)}`, async () => {
    const [agg] = await col('trips').aggregate<any>([
      matchStage(f),
      {
        $group: {
          _id: null,
          trips: { $sum: '$trips' },
          dropoffs: { $sum: '$dropoffs' },
          revenue: { $sum: '$revenue' },
          zones: { $addToSet: '$zone' },
          ...HOURS,
          kindHours: { $addToSet: { k: { $ne: ['$weather.kind', 'dry'] }, h: '$hour' } },
          temp: { $avg: '$weather.temp' },
          precip: { $avg: '$weather.precip' },
          fare: { $sum: { $multiply: ['$fare', '$trips'] } },
          tip: { $sum: { $multiply: ['$tip', '$trips'] } },
          distance: { $sum: { $multiply: ['$distance', '$trips'] } },
          duration: { $sum: { $multiply: ['$duration', '$trips'] } },
          passengers: { $sum: { $multiply: ['$passengers', '$trips'] } },
        },
      },
    ]).toArray();

    const [[hh], [tz]] = await Promise.all([
      col('trips').aggregate<any>([
        matchStage(f),
        { $group: { _id: '$cal.hod', trips: { $sum: '$trips' } } },
        { $sort: { trips: -1 } }, { $limit: 1 },
      ]).toArray(),
      col('trips').aggregate<any>([
        matchStage(f),
        { $group: { _id: '$zone', trips: { $sum: '$trips' }, revenue: { $sum: '$revenue' } } },
        { $sort: { trips: -1 } }, { $limit: 1 },
        { $lookup: { from: 'zones', localField: '_id', foreignField: 'id', as: 'z',
                     pipeline: [{ $project: { _id: 0, name: 1, borough: 1 } }] } },
      ]).toArray(),
    ]);

    const t = agg?.trips ?? 0;
    const hours = agg?._hours?.length ?? 0;
    const fare = t ? agg.fare / t : 0;
    const tip = t ? agg.tip / t : 0;
    return {
      trips: t, dropoffs: agg?.dropoffs ?? 0, net: t - (agg?.dropoffs ?? 0),
      revenue: round(agg?.revenue ?? 0),
      revenuePerTrip: t ? round((agg.revenue ?? 0) / t) : 0,
      farePerTrip: round(fare), tipPerTrip: round(tip),
      tipPct: fare ? round((100 * tip) / fare, 1) : 0,
      distance: t ? round(agg.distance / t) : 0,
      duration: t ? round(agg.duration / t, 1) : 0,
      passengers: t ? round(agg.passengers / t) : 0,
      hours, zones: agg?.zones?.length ?? 0,
      tripsPerHour: hours ? round(t / hours) : 0,
      revenuePerHour: hours ? round((agg?.revenue ?? 0) / hours) : 0,
      meanTemp: round(agg?.temp ?? 0, 1),
      meanPrecip: round(agg?.precip ?? 0, 2),
      wetHours: countWhere(agg?.kindHours, true),
      peakHour: hh ? { hod: hh._id, trips: hh.trips } : null,
      topZone: tz ? {
        id: tz._id, name: tz.z?.[0]?.name ?? `Zone ${tz._id}`,
        borough: tz.z?.[0]?.borough ?? 'Unknown',
        trips: tz.trips, revenue: round(tz.revenue),
      } : null,
    } satisfies Summary;
  });
}

/** Generic grouped profile with correct distinct-hour counts. */
function profile(f: Filter, field: string) {
  return cached(`prof:${field}:${filterKey(f)}`, async () => {
    const rows = await col('trips').aggregate<any>([
      matchStage(f),
      {
        $group: {
          _id: `$${field}`,
          trips: { $sum: '$trips' }, revenue: { $sum: '$revenue' },
          ...HOURS,
          dist: { $sum: { $multiply: ['$distance', '$trips'] } },
          amount: { $sum: { $multiply: ['$amount', '$trips'] } },
          tip: { $sum: { $multiply: ['$tip', '$trips'] } },
        },
      },
      SIZE_HOURS,
      DROP_HOURS,
      { $sort: { _id: 1 } },
    ]).toArray();
    return rows.map((r) => ({
      key: r._id as number | string,
      trips: r.trips as number,
      revenue: round(r.revenue as number),
      hours: r.hours as number,
      tripsPerHour: r.hours ? round(r.trips / r.hours) : 0,
      revenuePerHour: r.hours ? round(r.revenue / r.hours) : 0,
      revenuePerTrip: r.trips ? round(r.revenue / r.trips) : 0,
      distance: r.trips ? round(r.dist / r.trips) : 0,
      amount: r.trips ? round(r.amount / r.trips) : 0,
      tipPct: r.amount ? round((100 * r.tip) / r.amount, 1) : 0,
    }));
  });
}

export const byHour = (f: Filter) => profile(f, 'cal.hod');
export const byDow = (f: Filter) => profile(f, 'cal.dow');
export const byMonth = (f: Filter) => profile(f, 'cal.mon');

/** WMO weather codes present in the extract, in plain English. */
const CODE_LABEL: Record<number, string> = {
  0: 'Clear', 1: 'Mainly clear', 2: 'Partly cloudy', 3: 'Overcast',
  51: 'Light drizzle', 53: 'Drizzle', 55: 'Dense drizzle',
  61: 'Light rain', 63: 'Rain', 65: 'Heavy rain',
  71: 'Light snow', 73: 'Snow', 75: 'Heavy snow',
};
const CODE_KIND: Record<number, 'dry' | 'rain' | 'snow'> = {
  0: 'dry', 1: 'dry', 2: 'dry', 3: 'dry',
  51: 'rain', 53: 'rain', 55: 'rain', 61: 'rain', 63: 'rain', 65: 'rain',
  71: 'snow', 73: 'snow', 75: 'snow',
};

export async function byCode(f: Filter) {
  const rows = await profile(f, 'weather.code');
  return rows.map((r) => {
    const code = Number(r.key);
    return {
      ...r,
      code,
      label: CODE_LABEL[code] ?? `Code ${code}`,
      kind: CODE_KIND[code] ?? 'dry',
    };
  });
}

export const byKind = (f: Filter) => profile(f, 'weather.kind');

/** Hour x weekday matrix — mean citywide trips per hour in each cell. */
export function hourDowMatrix(f: Filter) {
  return cached(`matrix:${filterKey(f)}`, async () => {
    const rows = await col('trips').aggregate<any>([
      matchStage(f),
      {
        $group: {
          _id: { d: '$cal.dow', h: '$cal.hod' },
          trips: { $sum: '$trips' }, ...HOURS,
        },
      },
      SIZE_HOURS, DROP_HOURS,
    ]).toArray();
    const mat: number[][] = Array.from({ length: 7 }, () => new Array(24).fill(0));
    for (const r of rows) {
      if (r.hours > 0) mat[r._id.d][r._id.h] = round(r.trips / r.hours);
    }
    return mat;
  });
}

/** Zone cards under the current lens, names and boroughs joined in. */
export function zoneTable(f: Filter, limit = 200) {
  return cached(`ztable:${filterKey(f)}:${limit}`, async () => {
    const rows = await col('trips').aggregate<any>([
      matchStage(f),
      {
        $group: {
          _id: '$zone', trips: { $sum: '$trips' }, revenue: { $sum: '$revenue' },
          dist: { $sum: { $multiply: ['$distance', '$trips'] } },
          amount: { $sum: { $multiply: ['$amount', '$trips'] } },
          dur: { $sum: { $multiply: ['$duration', '$trips'] } },
          tip: { $sum: { $multiply: ['$tip', '$trips'] } },
        },
      },
      { $sort: { trips: -1 } },
      { $limit: limit },
      {
        $lookup: {
          from: 'zones', localField: '_id', foreignField: 'id', as: 'z',
          pipeline: [{ $project: { _id: 0, name: 1, borough: 1, mapped: 1 } }],
        },
      },
    ]).toArray();
    return rows.map((r) => ({
      id: r._id as number,
      name: r.z?.[0]?.name ?? `Zone ${r._id}`,
      borough: r.z?.[0]?.borough ?? 'Unknown',
      mapped: r.z?.[0]?.mapped ?? false,
      trips: r.trips as number,
      revenue: round(r.revenue as number),
      amount: r.trips ? round(r.amount / r.trips) : 0,
      distance: r.trips ? round(r.dist / r.trips) : 0,
      duration: r.trips ? round(r.dur / r.trips, 1) : 0,
      tipPct: r.amount ? round((100 * r.tip) / r.amount, 1) : 0,
    }));
  });
}

/**
 * The project's central comparison, run live in mongod.
 *
 * For each precipitation bin: the uncorrected ratio of trips per hour against
 * dry hours, and the controlled ratio computed only against dry hours inside the
 * same month-and-hour cell. The uncorrected figure is confounded by the clock;
 * the controlled one is the claim.
 */
export function rainEffect(f: Filter) {
  return cached(`rain:${filterKey(f)}`, async () => {
    const edges = [0.05, 0.25, 0.6, 1.2, 2.5, 5];
    const bounds = [...edges, 1e9];

    const [raw, dryAgg, dryCells, wetCells] = await Promise.all([
      col('trips').aggregate<any>([
        matchStage(f),
        { $match: { precip: { $gte: 0.05 } } },
        { $bucket: { groupBy: '$precip', boundaries: bounds, default: 'other',
                     output: { trips: { $sum: '$trips' }, _hours: { $addToSet: '$hour' } } } },
        { $addFields: { hours: { $size: '$_hours' } } },
        { $project: { _hours: 0 } },
      ]).toArray(),
      col('trips').aggregate<any>([
        matchStage(f), { $match: { precip: { $lt: 0.05 } } },
        { $group: { _id: null, trips: { $sum: '$trips' }, ...HOURS } },
        SIZE_HOURS, DROP_HOURS,
      ]).toArray(),
      col('trips').aggregate<any>([
        matchStage(f), { $match: { precip: { $lt: 0.05 } } },
        { $group: {
          _id: { $concat: [{ $toString: '$cal.mon' }, ':', { $toString: '$cal.hod' }] },
          trips: { $sum: '$trips' }, ...HOURS,
        } },
        SIZE_HOURS, DROP_HOURS,
        { $match: { hours: { $gte: 2 } } },
      ]).toArray(),
      col('trips').aggregate<any>([
        matchStage(f), { $match: { precip: { $gte: 0.05 } } },
        { $group: {
          _id: {
            b: { $switch: {
              branches: edges.map((lo, i) => ({
                case: { $and: [{ $gte: ['$precip', lo] }, { $lt: ['$precip', bounds[i + 1]] }] },
                then: i,
              })),
              default: -1,
            } },
            cell: { $concat: [{ $toString: '$cal.mon' }, ':', { $toString: '$cal.hod' }] },
          },
          trips: { $sum: '$trips' }, ...HOURS,
        } },
        SIZE_HOURS, DROP_HOURS,
        { $match: { '_id.b': { $gte: 0 }, hours: { $gte: 2 } } },
        // Within a bin the cells are disjoint, so the bin's hours are the sum of
        // the cells' hours. Re-collecting `$hour` here is impossible: the first
        // $group already consumed it.
        { $group: {
          _id: '$_id.b',
          cells: { $push: { cell: '$_id.cell', rate: { $divide: ['$trips', '$hours'] } } },
          hours: { $sum: '$hours' },
        } },
        { $sort: { _id: 1 } },
      ]).toArray(),
    ]);

    const dryRate = dryAgg[0]?.hours ? dryAgg[0].trips / dryAgg[0].hours : 0;
    const dryByCell = new Map<string, number>(
      dryCells.map((d) => [d._id as string, d.trips / d.hours]),
    );
    // $bucket keys its output on the lower boundary (0.05, 0.25, ...); the bins
    // below are keyed on the index. Edges and boundaries share values, so the
    // boundary for index i is edges[i].
    const rawByBound = new Map<number, { trips: number; hours: number }>(
      raw.filter((r) => typeof r._id === 'number').map((r) => [r._id, { trips: r.trips, hours: r.hours }]),
    );

    return {
      dryRate: round(dryRate),
      dryHours: dryAgg[0]?.hours ?? 0,
      bins: wetCells.map((b) => {
        const ratios: number[] = [];
        for (const c of b.cells) {
          const dr = dryByCell.get(c.cell);
          if (dr && dr > 0) ratios.push(c.rate / dr);
        }
        ratios.sort((p, q) => p - q);
        const hi = bounds[b._id + 1];
        return {
          bin: b._id as number,
          label: hi >= 1e9 ? `${edges[b._id].toFixed(1)}+` : `${edges[b._id].toFixed(1)}–${hi.toFixed(1)}`,
          hours: b.hours as number,
          cells: ratios.length,
          controlled: ratios.length ? round(ratios.reduce((a, v) => a + v, 0) / ratios.length, 4) : null,
          q1: ratios.length >= 4 ? round(ratios[Math.floor(ratios.length * 0.25)], 4) : null,
          q3: ratios.length >= 4 ? round(ratios[Math.floor(ratios.length * 0.75)], 4) : null,
          naive: (() => {
            const r = rawByBound.get(edges[b._id]);
            return r && r.hours && dryRate ? round(r.trips / r.hours / dryRate, 4) : null;
          })(),
        };
      }),
    };
  });
}

/** Weather-condition economics: what each sky does to a trip. */
export function codeEconomics(f: Filter) {
  return cached(`codeecon:${filterKey(f)}`, async () => {
    const rows = await col('trips').aggregate<any>([
      matchStage({ ...f, kind: 'all' }),
      {
        $group: {
          _id: '$weather.code',
          label: { $first: '$weather.label' },
          kind: { $first: '$weather.kind' },
          trips: { $sum: '$trips' }, revenue: { $sum: '$revenue' }, ...HOURS,
          amount: { $sum: { $multiply: ['$amount', '$trips'] } },
          fare: { $sum: { $multiply: ['$fare', '$trips'] } },
          tip: { $sum: { $multiply: ['$tip', '$trips'] } },
          dist: { $sum: { $multiply: ['$distance', '$trips'] } },
          dur: { $sum: { $multiply: ['$duration', '$trips'] } },
        },
      },
      SIZE_HOURS, DROP_HOURS,
      { $sort: { _id: 1 } },
    ]).toArray();
    return rows.map((r) => ({
      code: r._id as number, label: r.label as string, kind: r.kind as string,
      hours: r.hours as number, trips: r.trips as number,
      tripsPerHour: r.hours ? round(r.trips / r.hours) : 0,
      revenue: round(r.revenue),
      amount: r.trips ? round(r.amount / r.trips) : 0,
      fare: r.trips ? round(r.fare / r.trips) : 0,
      tipPct: r.fare ? round((100 * r.tip) / r.fare, 1) : 0,
      distance: r.trips ? round(r.dist / r.trips) : 0,
      duration: r.trips ? round(r.dur / r.trips, 1) : 0,
    }));
  });
}

/**
 * Does weather change WHERE the city goes? For each zone, its share of trips in
 * the wet lens against its share in dry hours. Weather is one citywide reading
 * per hour, so any share shift is compositional, not an exposure artefact.
 */
export function zoneShift(f: Filter, kind: 'rain' | 'snow' = 'rain') {
  return cached(`zshift:${kind}:${filterKey(f)}`, async () => {
    const wetKinds = kind === 'snow' ? ['snow'] : ['rain', 'snow'];
    const rows = await col('trips').aggregate<any>([
      matchStage(f),
      {
        $group: {
          _id: '$zone',
          dry: { $sum: { $cond: [{ $eq: ['$weather.kind', 'dry'] }, '$trips', 0] } },
          wet: { $sum: { $cond: [{ $in: ['$weather.kind', wetKinds] }, '$trips', 0] } },
        },
      },
      {
        $lookup: {
          from: 'zones', localField: '_id', foreignField: 'id', as: 'z',
          pipeline: [{ $project: { _id: 0, name: 1, borough: 1, distance: 1, mapped: 1 } }],
        },
      },
      { $match: { $expr: { $gte: [{ $add: ['$dry', '$wet'] }, 20000] } } },
      { $sort: { wet: -1 } },
    ]).toArray();
    const totWet = rows.reduce((a, r) => a + r.wet, 0) || 1;
    const totDry = rows.reduce((a, r) => a + r.dry, 0) || 1;
    return rows.map((r) => {
      const sw = r.wet / totWet, sd = r.dry / totDry;
      return {
        id: r._id as number,
        name: r.z?.[0]?.name ?? `Zone ${r._id}`,
        borough: r.z?.[0]?.borough ?? 'Unknown',
        mapped: r.z?.[0]?.mapped ?? false,
        zoneDistance: round(r.z?.[0]?.distance ?? 0),
        dryTrips: r.dry as number, wetTrips: r.wet as number, trips: (r.dry + r.wet) as number,
        shareDry: round(sd, 6), shareWet: round(sw, 6),
        deltaPP: round((sw - sd) * 100, 4),
        index: sd > 0 ? round(sw / sd, 4) : null,
      };
    });
  });
}

/** Temperature response. */
export function tempResponse(f: Filter) {
  return cached(`temp:${filterKey(f)}`, async () => {
    const bands = [-5, 0, 5, 10, 15, 20, 25, 30];
    const rows = await col('trips').aggregate<any>([
      matchStage(f),
      {
        $bucket: {
          groupBy: '$weather.temp', boundaries: bands, default: 'out',
          output: {
            trips: { $sum: '$trips' }, revenue: { $sum: '$revenue' }, ...HOURS,
            amount: { $sum: { $multiply: ['$amount', '$trips'] } },
            dist: { $sum: { $multiply: ['$distance', '$trips'] } },
          },
        },
      },
      SIZE_HOURS, DROP_HOURS,
      { $sort: { _id: 1 } },
    ]).toArray();
    const labels: Record<string, string> = {
      '-5': 'under −5', '0': '−5 to 0', '5': '0 to 5', '10': '5 to 10', '15': '10 to 15',
      '20': '15 to 20', '25': '20 to 25', '30': '25 to 30', out: 'over 30',
    };
    return rows.map((r) => ({
      band: labels[String(r._id)] ?? String(r._id),
      key: r._id === 'out' ? 99 : Number(r._id),
      trips: r.trips as number, hours: r.hours as number,
      tripsPerHour: r.hours ? round(r.trips / r.hours) : 0,
      amount: r.trips ? round(r.amount / r.trips) : 0,
      distance: r.trips ? round(r.dist / r.trips) : 0,
    }));
  });
}

/**
 * Origin/destination marginals per zone.
 *
 * The source carries `trip_count` (trips that STARTED in this zone) and
 * `dropoff_count` (trips that ENDED in it) as two counts per (hour, zone) row.
 * They are two marginals of the same trip set, not paired records, so this gives
 * net flow and separate origin/destination density — never a from-to matrix.
 * A true OD matrix would need a dropoff-zone column per trip, which the file
 * does not have. The 4.5% gap between the two totals is trips that ended outside
 * the 262 mapped zones.
 */
export function flowByZone(f: Filter) {
  return cached(`flow:${filterKey(f)}`, async () => {
    const rows = await col('trips').aggregate<any>([
      matchStage(f),
      {
        $group: {
          _id: '$zone',
          pickups: { $sum: '$trips' },
          dropoffs: { $sum: '$dropoffs' },
          revenue: { $sum: '$revenue' },
        },
      },
      { $addFields: { net: { $subtract: ['$pickups', '$dropoffs'] } } },
      {
        $lookup: {
          from: 'zones', localField: '_id', foreignField: 'id', as: 'z',
          pipeline: [{ $project: { _id: 0, name: 1, borough: 1, mapped: 1, amount: 1 } }],
        },
      },
      { $match: { $expr: { $gte: [{ $add: ['$pickups', '$dropoffs'] }, 20000] } } },
      { $sort: { net: -1 } },
    ]).toArray();
    return rows.map((r) => {
      const total = r.pickups + r.dropoffs;
      return {
        id: r._id as number,
        name: r.z?.[0]?.name ?? `Zone ${r._id}`,
        borough: r.z?.[0]?.borough ?? 'Unknown',
        mapped: r.z?.[0]?.mapped ?? false,
        pickups: r.pickups as number,
        dropoffs: r.dropoffs as number,
        net: r.net as number,
        balance: total ? round(r.net / total, 4) : 0,
        ratio: r.dropoffs ? round(r.pickups / r.dropoffs, 3) : null,
        revenue: round(r.revenue as number),
      };
    });
  });
}

/** Net flow over the clock: the city's daily breathing, and any one zone's. */
export function flowByHour(f: Filter, zone: number | null = null) {
  return cached(`flowhour:${zone ?? 'city'}:${filterKey(f)}`, async () => {
    const stages: any[] = [matchStage(f)];
    if (zone != null) stages.push({ $match: { zone } });
    stages.push(
      {
        $group: {
          _id: { $cond: [zone != null, '$cal.hod', '$cal.hod'] },
          pickups: { $sum: '$trips' },
          dropoffs: { $sum: '$dropoffs' },
          ...HOURS,
        },
      },
      SIZE_HOURS, DROP_HOURS,
      { $sort: { _id: 1 } },
    );
    const rows = await col('trips').aggregate<any>(stages).toArray();
    return rows.map((r) => ({
      hod: r._id as number,
      pickups: r.pickups as number,
      dropoffs: r.dropoffs as number,
      net: (r.pickups - r.dropoffs) as number,
      pickupsPerHour: r.hours ? round(r.pickups / r.hours) : 0,
      dropoffsPerHour: r.hours ? round(r.dropoffs / r.hours) : 0,
      netPerHour: r.hours ? round((r.pickups - r.dropoffs) / r.hours) : 0,
      hours: r.hours as number,
    }));
  });
}

/** Cumulative trip concentration: how few zones carry how much of the city. */
export function concentration(f: Filter) {
  return cached(`conc:${filterKey(f)}`, async () => {
    const rows = await col('trips').aggregate<any>([
      matchStage(f),
      { $group: { _id: '$zone', trips: { $sum: '$trips' } } },
      { $sort: { trips: -1 } },
      { $group: { _id: null, all: { $push: '$trips' }, total: { $sum: '$trips' } } },
      { $project: {
        _id: 0, total: 1,
        cum: { $reduce: {
          input: '$all', initialValue: { s: 0, out: [] },
          in: { s: { $add: ['$$value.s', '$$this'] },
                out: { $concatArrays: ['$$value.out', [{ $add: ['$$value.s', '$$this'] }]] } },
        } },
      } },
    ]).toArray();
    if (!rows[0]) return { total: 0, points: [] };
    const { total, cum } = rows[0];
    return {
      total,
      points: cum.out.map((c: number, i: number) => ({ n: i + 1, share: round((100 * c) / total, 3) })),
    };
  });
}

/** Seasonality with a snow flag, so the one visible weather effect is visible. */
export function seasonality(f: Filter) {
  return cached(`season:${filterKey(f)}`, async () => {
    const rows = await col('trips').aggregate<any>([
      matchStage({ ...f, hod: f.hod }),
      { $group: {
        _id: '$cal.mon',
        trips: { $sum: '$trips' }, revenue: { $sum: '$revenue' }, ...HOURS,
        kindHours: { $addToSet: { k: { $gt: ['$weather.snow', 0] }, h: '$hour' } },
        precip: { $sum: '$weather.precip' },
        temp: { $avg: '$weather.temp' },
      } },
      SIZE_HOURS, DROP_HOURS,
      { $sort: { _id: 1 } },
    ]).toArray();
    return rows.map((r) => ({
      mon: r._id as number,
      trips: r.trips as number, hours: r.hours as number,
      tripsPerHour: r.hours ? round(r.trips / r.hours) : 0,
      revenuePerHour: r.hours ? round(r.revenue / r.hours) : 0,
      snowHours: countWhere(r.kindHours, true),
      precipPerHour: r.hours ? round(r.precip / r.hours, 3) : 0,
      temp: round(r.temp ?? 0, 1),
    }));
  });
}

/**
 * The citywide hourly series for the year trace — 8,759 records, one per
 * recorded hour, no sampling. Served from the `hourly` collection because it is
 * already exactly that shape.
 */
export function citywideSeries() {
  return cached('series', async () => {
    const docs = await col('hourly').aggregate<any>([
      { $sort: { hour: 1 } },
      { $project: {
        _id: 0, mon: '$cal.mon', hod: '$cal.hod', doy: '$cal.doy', dow: '$cal.dow',
        trips: 1, revenue: 1, kind: '$weather.kind', code: '$weather.code',
        temp: '$weather.temp', precip: '$weather.precip', snow: '$weather.snow',
      } },
    ]).toArray();
    return docs;
  });
}

/** Distinct weather variables per hour, for the distributions. */
export function weatherDistributions() {
  return cached('wxdist', async () => {
    return col('hourly').aggregate<any>([
      { $project: {
        _id: 0, mon: '$cal.mon', hod: '$cal.hod', kind: '$weather.kind',
        code: '$weather.code', label: '$weather.label',
        temp: '$weather.temp', apparent: '$weather.apparent',
        humidity: '$weather.humidity', precip: '$weather.precip',
        snow: '$weather.snow', wind: '$weather.wind', gust: '$weather.gust',
        cloud: '$weather.cloud',
      } },
      { $sort: { mon: 1, hod: 1 } },
    ]).toArray();
  });
}

/** Zones within a radius of a point — a real MongoDB 2dsphere query. */
export function zonesNear(lng: number, lat: number, km: number, limit = 25) {
  return cached(`near:${lng}:${lat}:${km}:${limit}`, async () => {
    return col('zones').aggregate<any>([
      {
        $geoNear: {
          near: { type: 'Point', coordinates: [lng, lat] },
          distanceField: 'metres',
          maxDistance: km * 1000,
          spherical: true,
          key: 'geometry',
        },
      },
      { $limit: limit },
      { $project: {
        _id: 0, id: 1, name: 1, borough: 1, trips: 1, revenue: 1, amount: 1,
        distance: 1, peakHour: 1,
        km: { $round: [{ $divide: ['$metres', 1000] }, 3] },
      } },
    ]).toArray();
  });
}

/** Borough rollup under the lens. */
export function byBorough(f: Filter) {
  return cached(`borough:${filterKey(f)}`, async () => {
    const rows = await col('trips').aggregate<any>([
      matchStage(f),
      { $group: { _id: '$zone', trips: { $sum: '$trips' }, revenue: { $sum: '$revenue' },
                  amount: { $sum: { $multiply: ['$amount', '$trips'] } },
                  dist: { $sum: { $multiply: ['$distance', '$trips'] } } } },
      { $lookup: { from: 'zones', localField: '_id', foreignField: 'id', as: 'z',
                   pipeline: [{ $project: { _id: 0, borough: 1 } }] } },
      { $group: {
        _id: { $ifNull: [{ $first: '$z.borough' }, 'Unknown'] },
        trips: { $sum: '$trips' }, revenue: { $sum: '$revenue' },
        amount: { $sum: '$amount' }, dist: { $sum: '$dist' }, zones: { $sum: 1 },
      } },
      { $sort: { trips: -1 } },
    ]).toArray();
    return rows.map((r) => ({
      borough: r._id as string, zones: r.zones as number,
      trips: r.trips as number, revenue: round(r.revenue),
      amount: r.trips ? round(r.amount / r.trips) : 0,
      distance: r.trips ? round(r.dist / r.trips) : 0,
    }));
  });
}

/** One zone, in full, under the current lens. */
export function zoneDetail(id: number, f: Filter) {
  return cached(`zd:${id}:${filterKey(f)}`, async () => {
    const [doc] = await col('zones').find({ id }).project({ _id: 0, geometry: 0 }).limit(1).toArray();
    if (!doc) return null;
    const [prof] = await col('trips').aggregate<any>([
      matchStage(f),
      { $match: { zone: id } },
      { $facet: {
        hourly: [
          { $group: { _id: '$cal.hod', trips: { $sum: '$trips' }, revenue: { $sum: '$revenue' }, ...HOURS } },
          SIZE_HOURS, DROP_HOURS, { $sort: { _id: 1 } },
        ],
        bykind: [
          { $group: { _id: '$weather.kind', trips: { $sum: '$trips' }, revenue: { $sum: '$revenue' }, ...HOURS } },
          SIZE_HOURS, DROP_HOURS, { $sort: { _id: 1 } },
        ],
        flow: [
          { $group: { _id: '$cal.hod', pickups: { $sum: '$trips' }, dropoffs: { $sum: '$dropoffs' }, ...HOURS } },
          SIZE_HOURS, DROP_HOURS, { $sort: { _id: 1 } },
        ],
        total: [
          { $group: {
            _id: null, trips: { $sum: '$trips' }, dropoffs: { $sum: '$dropoffs' },
            revenue: { $sum: '$revenue' }, ...HOURS,
            amount: { $sum: { $multiply: ['$amount', '$trips'] } },
            fare: { $sum: { $multiply: ['$fare', '$trips'] } },
            tip: { $sum: { $multiply: ['$tip', '$trips'] } },
            dist: { $sum: { $multiply: ['$distance', '$trips'] } },
            dur: { $sum: { $multiply: ['$duration', '$trips'] } },
          } },
          SIZE_HOURS, DROP_HOURS,
        ],
      } },
    ]).toArray();
    const t = prof?.total?.[0];
    return {
      zone: doc,
      hourly: (prof.hourly ?? []).map((r: any) => ({ hod: r._id, trips: r.trips, revenue: round(r.revenue), hours: r.hours })),
      bykind: (prof.bykind ?? []).map((r: any) => ({ kind: r._id, trips: r.trips, revenue: round(r.revenue), hours: r.hours })),
      flow: (prof.flow ?? []).map((r: any) => ({ hod: r._id, pickups: r.pickups, dropoffs: r.dropoffs, net: r.pickups - r.dropoffs })),
      filtered: t ? {
        trips: t.trips, revenue: round(t.revenue), hours: t.hours,
        amount: t.trips ? round(t.amount / t.trips) : 0,
        fare: t.trips ? round(t.fare / t.trips) : 0,
        tipPct: t.fare ? round((100 * t.tip) / t.fare, 1) : 0,
        distance: t.trips ? round(t.dist / t.trips) : 0,
        duration: t.trips ? round(t.dur / t.trips, 1) : 0,
        dropoffs: t.dropoffs ?? 0,
        net: t.trips - (t.dropoffs ?? 0),
      } : null,
    };
  });
}

/** Model output from scripts/forecast.py: out-of-sample backtest, the next seven
 *  days, and the metrics that say whether the model earns its place. */
export function forecast() {
  return forecastData;
}

/** Provenance and index inventory for the method page. */
export function meta() {
  return cached('meta', async () => {
    const [m] = await col('meta').find({}).toArray();
    const counts = {
      trips: await col('trips').estimatedDocumentCount(),
      hourly: await col('hourly').estimatedDocumentCount(),
      zones: await col('zones').estimatedDocumentCount(),
      rollups: await col('rollups').estimatedDocumentCount(),
    };
    return { provenance: m, counts };
  });
}

export { round };
