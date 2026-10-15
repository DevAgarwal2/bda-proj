import type { APIRoute } from 'astro';
import { parseFilter, zoneDetail } from '../../../server/pipelines';

export const prerender = false;

export const GET: APIRoute = async ({ url, params }) => {
  const id = Number(params.id);
  if (!Number.isFinite(id)) return Response.json({ error: 'bad zone id' }, { status: 400 });
  try {
    const data = await zoneDetail(id, parseFilter(url.searchParams));
    if (!data) return Response.json({ error: 'zone not found' }, { status: 404 });
    return Response.json(data, { headers: { 'cache-control': 'no-store' } });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
};
