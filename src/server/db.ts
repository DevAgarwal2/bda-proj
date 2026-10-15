import { MongoClient, type Db, type Collection } from 'mongodb';

/**
 * One MongoClient for the process. Astro's dev server re-evaluates modules on
 * hot reload, so the client is cached on globalThis or every edit would leak a
 * new connection pool.
 */
const URI = import.meta.env.MONGO_URI ?? process.env.MONGO_URI ?? 'mongodb://127.0.0.1:27017';
const DBNAME = import.meta.env.MONGO_DB ?? process.env.MONGO_DB ?? 'nyc_taxi';

declare global {
  // eslint-disable-next-line no-var
  var __nycTaxiMongo: { client: MongoClient; db: Db } | undefined;
}

function connect() {
  if (!globalThis.__nycTaxiMongo) {
    const client = new MongoClient(URI, { serverSelectionTimeoutMS: 8000, maxPoolSize: 12 });
    globalThis.__nycTaxiMongo = { client, db: client.db(DBNAME) };
  }
  return globalThis.__nycTaxiMongo;
}

export const db = () => connect().db;
export const col = <T extends Record<string, unknown>>(name: string): Collection<T> =>
  db().collection<T>(name) as Collection<T>;

export const DB_NAME = DBNAME;
export const DB_URI = URI;

/** Small in-process response cache. Aggregations are 40–200 ms, but the filter
 *  bar fires one request per panel and repeated filters should not re-scan.
 *  Disabled in dev: a module-level cache that survives a hot reload serves
 *  results from code that no longer exists, which costs more than it saves. */
const cache = new Map<string, { at: number; value: unknown }>();
const TTL = import.meta.env.DEV ? 0 : 45_000;

export async function cached<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const hit = TTL ? cache.get(key) : undefined;
  if (hit && Date.now() - hit.at < TTL) return hit.value as T;
  const value = await fn();
  cache.set(key, { at: Date.now(), value });
  if (cache.size > 300) cache.delete(cache.keys().next().value!);
  return value;
}

export function cacheClear() {
  cache.clear();
}
