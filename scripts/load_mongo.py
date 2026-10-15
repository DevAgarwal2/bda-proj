"""Load the NYC taxi x weather extract into MongoDB, then materialise the rollups
the dashboard reads.

Database: nyc_taxi  (override with MONGO_URI / MONGO_DB)
  trips        976,425 raw (hour x pickup zone) rows, weather denormalised on
  hourly       8,759 citywide hourly records — the master time series
  zones        262 zones with names, boroughs, geometry and annual totals
  rollups      per-dimension profiles + the zone joint cubes, one doc each
  findings     every headline number the dashboard prints, computed by analyse.py
  meta         provenance, row counts, indexes, and the query log

Run:  .venv/bin/python scripts/load_mongo.py
"""
import json, os, sys, time, datetime as dt
import numpy as np
import pandas as pd
from pymongo import MongoClient, ASCENDING, GEOSPHERE
from pymongo import UpdateOne

SRC = "nyc_taxi_weather_hourly.csv"
URI = os.environ.get("MONGO_URI", "mongodb://127.0.0.1:27017")
DB = os.environ.get("MONGO_DB", "nyc_taxi")
BATCH = 20000

t0 = time.time()
def log(msg):
    print(f"[{time.time()-t0:6.1f}s] {msg}", flush=True)

# --------------------------------------------------------------------- client
cli = MongoClient(URI, serverSelectionTimeoutMS=8000)
cli.admin.command("ping")
db = cli[DB]
log(f"connected to {URI} / {DB}  (mongod {cli.server_info()['version']})")

# Drop only the collections this loader owns, so a re-run is idempotent.
for c in ("trips", "hourly", "zones", "rollups", "findings", "meta"):
    db[c].drop()
db.zone_shapes.drop()

# ------------------------------------------------------------------- geometry
geo = json.load(open("public/geo/taxi_zones.geojson"))
geoby = {int(f["properties"]["locationid"]): f for f in geo["features"]}
log(f"geometry loaded: {len(geoby)} TLC zones")

# ------------------------------------------------------------------------ read
WANT = [
    "pickup_hour", "PULocationID", "trip_count", "avg_fare", "avg_total_amount",
    "avg_trip_distance", "avg_passenger_count", "total_revenue", "avg_tip_amount",
    "avg_trip_duration_min", "dropoff_count", "temperature_2m", "apparent_temperature",
    "relative_humidity_2m", "precipitation", "rain", "snowfall", "weather_code",
    "wind_speed_10m", "wind_gusts_10m", "cloud_cover", "hour_of_day", "day_of_week",
    "is_weekend", "month", "day_of_month",
]
log("reading CSV")
df = pd.read_csv(SRC, usecols=WANT,
                 dtype={"pickup_hour": "string", "PULocationID": "int32",
                        "weather_code": "int16", "hour_of_day": "int8",
                        "day_of_week": "int8", "month": "int8", "day_of_month": "int8",
                        "is_weekend": "bool"})
df["pickup_hour"] = pd.to_datetime(df["pickup_hour"])
log(f"{len(df):,} rows, {df.pickup_hour.nunique():,} distinct hours, {df.PULocationID.nunique()} zones")

# ------------------------------------------------------------- weather classes
PRCP = df.precipitation.to_numpy(np.float64)
SNOW = df.snowfall.to_numpy(np.float64)
CODE = df.weather_code.to_numpy(np.int64)
LBL = {0: "Clear", 1: "Mainly clear", 2: "Partly cloudy", 3: "Overcast",
       51: "Light drizzle", 53: "Drizzle", 55: "Dense drizzle",
       61: "Light rain", 63: "Rain", 65: "Heavy rain",
       71: "Light snow", 73: "Snow", 75: "Heavy snow"}
KIND = {}
for c in set(CODE.tolist()):
    s = LBL[c].lower()
    KIND[c] = "snow" if "snow" in s else ("rain" if ("rain" in s or "drizzle" in s) else "dry")
df["weather_kind"] = [KIND[int(c)] for c in CODE]
df["is_wet"] = (PRCP > 0)
df["is_snowing"] = (SNOW > 0)

# ------------------------------------------------------------ load the raw set
log("writing trips")
trips = db.trips
trips.create_index([("hour", ASCENDING)])
trips.create_index([("zone", ASCENDING)])
trips.create_index([("hour", ASCENDING), ("zone", ASCENDING)])
trips.create_index([("cal.mon", ASCENDING), ("cal.hod", ASCENDING)])
trips.create_index([("weather.kind", ASCENDING)])
trips.create_index([("precip", ASCENDING)])
trips.create_index([("trips", ASCENDING)])

rows = df.to_dict("records")
def to_doc(r):
    return {
        "hour": r["pickup_hour"].to_pydatetime(),
        "zone": int(r["PULocationID"]),
        "trips": int(r["trip_count"]),
        "revenue": float(r["total_revenue"]),
        "fare": float(r["avg_fare"]),
        "amount": float(r["avg_total_amount"]),
        "distance": float(r["avg_trip_distance"]),
        "passengers": float(r["avg_passenger_count"]),
        "tip": float(r["avg_tip_amount"]),
        "duration": float(r["avg_trip_duration_min"]),
        "dropoffs": int(r["dropoff_count"]),
        "precip": float(r["precipitation"]),
        "snow": float(r["snowfall"]),
        "temp": float(r["temperature_2m"]),
        "weather": {
            "code": int(r["weather_code"]), "kind": r["weather_kind"],
            "label": LBL[int(r["weather_code"])],
            "temp": float(r["temperature_2m"]), "apparent": float(r["apparent_temperature"]),
            "humidity": int(r["relative_humidity_2m"]), "precip": float(r["precipitation"]),
            "rain": float(r["rain"]), "snow": float(r["snowfall"]),
            "wind": float(r["wind_speed_10m"]), "gust": float(r["wind_gusts_10m"]),
            "cloud": int(r["cloud_cover"]),
        },
        "cal": {
            "hod": int(r["hour_of_day"]), "dow": int(r["day_of_week"]),
            "mon": int(r["month"]), "dom": int(r["day_of_month"]),
            "weekend": bool(r["is_weekend"]),
        },
    }

n = len(rows)
for i in range(0, n, BATCH):
    chunk = [to_doc(r) for r in rows[i:i + BATCH]]
    try:
        trips.insert_many(chunk, ordered=False)
    except Exception as e:
        log(f"  batch {i}: {e}")
    if (i // BATCH) % 8 == 0:
        log(f"  trips {min(i+BATCH, n):,}/{n:,}")
log(f"trips loaded: {trips.estimated_document_count():,}")

# ------------------------------------------------------- citywide hourly series
log("writing hourly")
g = df.groupby("pickup_hour", sort=True)
def wavg(frame, col):
    return float(np.average(frame[col].to_numpy(np.float64),
                            weights=frame.trip_count.to_numpy(np.float64)))
city = pd.DataFrame({
    "trips": g.trip_count.sum(), "revenue": g.total_revenue.sum(),
    "fare": g.apply(wavg, "avg_fare"), "amount": g.apply(wavg, "avg_total_amount"),
    "distance": g.apply(wavg, "avg_trip_distance"), "passengers": g.apply(wavg, "avg_passenger_count"),
    "tip": g.apply(wavg, "avg_tip_amount"), "duration": g.apply(wavg, "avg_trip_duration_min"),
}).reset_index()
wc = g[["temperature_2m", "apparent_temperature", "relative_humidity_2m", "precipitation",
        "rain", "snowfall", "weather_code", "wind_speed_10m", "wind_gusts_10m", "cloud_cover"]].first().reset_index()
city = city.merge(wc, on="pickup_hour")
city["hod"] = city.pickup_hour.dt.hour
city["dow"] = city.pickup_hour.dt.dayofweek
city["mon"] = city.pickup_hour.dt.month
city["doy"] = city.pickup_hour.dt.dayofyear

hourly = [{
    "hour": r.pickup_hour.to_pydatetime(),
    "trips": int(r.trips), "revenue": float(r.revenue),
    "fare": round(float(r.fare), 4), "amount": round(float(r.amount), 4),
    "distance": round(float(r.distance), 4), "passengers": round(float(r.passengers), 4),
    "tip": round(float(r.tip), 4), "duration": round(float(r.duration), 4),
    "cal": {"hod": int(r.hod), "dow": int(r.dow), "mon": int(r.mon), "doy": int(r.doy)},
    "weather": {
        "code": int(r.weather_code), "label": LBL[int(r.weather_code)],
        "kind": KIND[int(r.weather_code)],
        "temp": float(r.temperature_2m), "apparent": float(r.apparent_temperature),
        "humidity": int(r.relative_humidity_2m), "precip": float(r.precipitation),
        "rain": float(r.rain), "snow": float(r.snowfall),
        "wind": float(r.wind_speed_10m), "gust": float(r.wind_gusts_10m),
        "cloud": int(r.cloud_cover),
    },
} for r in city.itertuples()]
db.hourly.insert_many(hourly, ordered=True)
db.hourly.create_index([("hour", ASCENDING)], unique=True)
db.hourly.create_index([("cal.mon", ASCENDING), ("cal.hod", ASCENDING)])
log(f"hourly loaded: {db.hourly.estimated_document_count():,}")

# ---------------------------------------------------------------- zone rollups
log("writing zones")
zmeta = pd.DataFrame({"z": df.PULocationID.to_numpy(np.int32),
                      "t": df.trip_count.to_numpy(np.float64),
                      "r": df.total_revenue.to_numpy(np.float64)})
for c in ["avg_fare", "avg_total_amount", "avg_trip_distance", "avg_passenger_count",
          "avg_tip_amount", "avg_trip_duration_min"]:
    zmeta["w_" + c] = df[c].to_numpy(np.float64) * zmeta.t

zone_docs = []
for z, row in zmeta.groupby("z", sort=True).sum().iterrows():
    zid = int(z)
    tot = float(row["t"])
    p = geoby.get(zid, {}).get("properties", {})
    feat = geoby.get(zid)
    doc = {
        "id": zid,
        "name": p.get("zone", f"Zone {zid}"),
        "borough": p.get("borough", "Unknown"),
        "mapped": feat is not None,
        "trips": int(round(tot)),
        "revenue": round(float(row["r"]), 2),
        "fare": round(float(row["w_avg_fare"]) / tot, 4),
        "amount": round(float(row["w_avg_total_amount"]) / tot, 4),
        "distance": round(float(row["w_avg_trip_distance"]) / tot, 4),
        "passengers": round(float(row["w_avg_passenger_count"]) / tot, 4),
        "tip": round(float(row["w_avg_tip_amount"]) / tot, 4),
        "duration": round(float(row["w_avg_trip_duration_min"]) / tot, 4),
        "peakHour": int(city.hod.mode().iloc[0]) if False else None,
    }
    if feat is not None:
        doc["geometry"] = feat["geometry"]
    zone_docs.append(doc)

# peak hour / month / weekday per zone, from the joint cubes computed below
zones = db.zones
zones.insert_many(zone_docs, ordered=False)
zones.create_index([("id", ASCENDING)], unique=True)
zones.create_index([("trips", ASCENDING)])
zones.create_index([("borough", ASCENDING)])
zones.create_index([("geometry", GEOSPHERE)])
log(f"zones loaded: {zones.estimated_document_count():,}  (2dsphere index on geometry)")

# ------------------------------------------------------------ rollup documents
log("writing rollups")
zi = df.PULocationID.map({int(z): i for i, z in enumerate(sorted(df.PULocationID.unique()))}).to_numpy()
trips_v = df.trip_count.to_numpy(np.float64)
rev_v = df.total_revenue.to_numpy(np.float64)
NZ = int(zi.max()) + 1
zid_sorted = sorted(int(z) for z in df.PULocationID.unique())

def cube(keys):
    dims = [int(k.max()) + 1 for k in keys]
    n = int(np.prod(dims))
    nt = np.zeros(NZ * n); nr = np.zeros(NZ * n)
    flat = np.zeros(len(df), dtype=np.int64)
    for k, d in zip(keys, dims):
        flat = flat * d + k.astype(np.int64)
    flat = zi.astype(np.int64) * n + flat
    np.add.at(nt, flat, trips_v); np.add.at(nr, flat, rev_v)
    return nt.reshape(NZ, *dims), nr.reshape(NZ, *dims)

hod = df.hour_of_day.to_numpy(np.int64)
dow = df.day_of_week.to_numpy(np.int64)
mon = df.month.to_numpy(np.int64) - 1
wxmap = {c: i for i, c in enumerate(sorted(set(CODE.tolist())))}
wx = np.array([wxmap[int(c)] for c in CODE], np.int64)
tbmap = {b: i for i, b in enumerate([-99, -5, 0, 5, 10, 15, 20, 25, 30, 99])}
tb = np.digitize(df.temperature_2m.to_numpy(np.float64), [-5, 0, 5, 10, 15, 20, 25, 30]).astype(np.int64)
TEMP_BANDS = ["< −5", "−5–0", "0–5", "5–10", "10–15", "15–20", "20–25", "25–30", "> 30"]

c_hod, r_hod = cube([hod]); c_dow, r_dow = cube([dow]); c_mon, r_mon = cube([mon])
c_wx, r_wx = cube([wx]); c_tb, r_tb = cube([tb])
c_mh, r_mh = cube([mon, hod]); c_dh, r_dh = cube([dow, hod])
log("  cubes built")

def nest(a):
    a = np.asarray(a)
    return [int(v) for v in a] if a.ndim == 1 else [nest(x) for x in a]

db.rollups.insert_many([
    {"_id": "profile_hour",
     "trips": [int(v) for v in c_hod.sum(0)], "revenue": [int(v) for v in r_hod.sum(0)]},
    {"_id": "profile_dow",
     "trips": [int(v) for v in c_dow.sum(0)], "revenue": [int(v) for v in r_dow.sum(0)]},
    {"_id": "profile_month",
     "trips": [int(v) for v in c_mon.sum(0)], "revenue": [int(v) for v in r_mon.sum(0)]},
    {"_id": "profile_weather",
     "codes": sorted(wxmap, key=wxmap.get),
     "trips": [int(v) for v in c_wx.sum(0)], "revenue": [int(v) for v in r_wx.sum(0)]},
    {"_id": "profile_temp",
     "bands": TEMP_BANDS,
     "trips": [int(v) for v in c_tb.sum(0)], "revenue": [int(v) for v in r_tb.sum(0)]},
    {"_id": "zone_by_hour", "ids": zid_sorted,
     "trips": nest(c_hod), "revenue": nest(r_hod)},
    {"_id": "zone_by_dow", "ids": zid_sorted,
     "trips": nest(c_dow), "revenue": nest(r_dow)},
    {"_id": "zone_by_month", "ids": zid_sorted,
     "trips": nest(c_mon), "revenue": nest(r_mon)},
    {"_id": "zone_by_weather", "ids": zid_sorted, "codes": sorted(wxmap, key=wxmap.get),
     "trips": nest(c_wx), "revenue": nest(r_wx)},
    {"_id": "zone_by_temp", "ids": zid_sorted, "bands": TEMP_BANDS,
     "trips": nest(c_tb), "revenue": nest(r_tb)},
    {"_id": "zone_month_hour", "ids": zid_sorted,
     "trips": nest(c_mh), "revenue": nest(r_mh)},
    {"_id": "zone_dow_hour", "ids": zid_sorted,
     "trips": nest(c_dh), "revenue": nest(r_dh)},
], ordered=False)
log(f"rollups loaded: {db.rollups.estimated_document_count()} docs")

# zone peak hours, now that the cubes exist
zpos = {z: i for i, z in enumerate(zid_sorted)}
ops = [UpdateOne({"id": z}, {"$set": {
    "peakHour": int(np.argmax(c_hod[zpos[z]])),
    "peakDow": int(np.argmax(c_dow[zpos[z]])),
    "peakMonth": int(np.argmax(c_mon[zpos[z]])),
}}) for z in zid_sorted]
zones.bulk_write(ops, ordered=False)

# ------------------------------------------------------------------- findings
if os.path.exists("src/data/findings.json"):
    f = json.load(open("src/data/findings.json"))
    db.findings.insert_one({"_id": "latest", **f})
    log("findings loaded")

# ----------------------------------------------------------------------- meta
db.meta.insert_one({
    "_id": "provenance",
    "source": SRC,
    "sourceRows": int(len(df)),
    "distinctHours": int(df.pickup_hour.nunique()),
    "zones": int(df.PULocationID.nunique()),
    "mappedZones": len(geoby),
    "trips": int(df.trip_count.sum()),
    "revenue": round(float(df.total_revenue.sum()), 2),
    "missingHours": ["2025-03-09T02:00:00"],
    "dateRange": ["2025-01-01T00:00:00", "2025-12-31T23:00:00"],
    "geometrySource": "NYC TLC taxi zones, NYC Open Data dataset 8meu-9t5y",
    "loadedAt": dt.datetime.now(dt.timezone.utc),
    "collections": {
        "trips": trips.estimated_document_count(),
        "hourly": db.hourly.estimated_document_count(),
        "zones": zones.estimated_document_count(),
        "rollups": db.rollups.estimated_document_count(),
    },
    "indexes": {c: [dict(i) for i in db[c].list_indexes()] for c in ("trips", "hourly", "zones")},
})
db.trips.create_index([("weather.kind", ASCENDING), ("cal.hod", ASCENDING)])
log(f"meta written. total elapsed {time.time()-t0:.1f}s")
print(json.dumps({"ok": True, "db": DB, "uri": URI}, indent=1))
