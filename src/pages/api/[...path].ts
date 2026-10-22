import type { APIRoute } from 'astro';
import {
  parseFilter, summary, byHour, byDow, byMonth, byCode, byKind, hourDowMatrix, zoneTable,
  rainEffect, codeEconomics, zoneShift, tempResponse, concentration, seasonality,
  weatherDistributions, byBorough, zonesNear, meta, citywideSeries,
  flowByZone, flowByHour, forecast,
} from '../../server/pipelines';

export const prerender = false;

/**
 * One dispatcher rather than a dozen files: the path after /api is the pipeline
 * name, and ?mon=&dow=&hod=&kind= is the lens. Keeps the exposed query surface
 * exactly as large as the set of aggregations it actually offers.
 */
export const GET: APIRoute = async ({ url, params }) => {
  const route = String(params.path ?? '').replace(/^\/+|\/+$/g, '');
  const f = parseFilter(url.searchParams);
  // Number(null) is 0, so an absent param must be caught before Number().
  const num = (k: string, d: number) => {
    const raw = url.searchParams.get(k);
    if (raw == null || raw === '') return d;
    const v = Number(raw);
    return Number.isFinite(v) ? v : d;
  };

  try {
    const data = await (async (): Promise<unknown> => {
      switch (route) {
        case 'summary': return summary(f);
        case 'cab/hour': return byHour(f);
        case 'cab/dow': return byDow(f);
        case 'cab/month': return byMonth(f);
        case 'cab/matrix': return hourDowMatrix(f);
        case 'cab/concentration': return concentration(f);
        case 'cab/series': return citywideSeries();
        case 'cab/borough': return byBorough(f);
        case 'weather/code': return byCode(f);
        case 'weather/kind': return byKind(f);
        case 'weather/season': return seasonality(f);
        case 'weather/vars': return weatherDistributions();
        case 'weather/economics': return codeEconomics(f);
        case 'interaction/rain': return rainEffect(f);
        case 'interaction/temp': return tempResponse(f);
        case 'interaction/zone-shift':
          return zoneShift(f, url.searchParams.get('on') === 'snow' ? 'snow' : 'rain');
        case 'flow/zones': return flowByZone(f);
        case 'flow/hour': return flowByHour(f, url.searchParams.get('zone') ? Number(url.searchParams.get('zone')) : null);
        case 'zones': return zoneTable(f, Math.min(300, num('limit', 200)));
        case 'zones/near':
          return zonesNear(num('lng', -73.9857), num('lat', 40.7484), num('km', 2), num('limit', 20));
        case 'forecast': return forecast();
        case 'meta': return meta();
        default: return null;
      }
    })();

    if (data === null) return Response.json({ error: `unknown route "${route}"` }, { status: 404 });
    return Response.json(data, { headers: { 'cache-control': 'no-store' } });
  } catch (e) {
    return Response.json({ error: (e as Error).message, route }, { status: 500 });
  }
};
