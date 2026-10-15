"""Aggregate nyc_taxi_weather_hourly.csv into a compact client-side cube.

Reads 976,425 rows of (hour x pickup zone) with joined citywide weather and emits
pre-aggregated JSON payloads. All multi-zone means are re-weighted by trip_count;
nothing here averages per-(hour, zone) means naively.
"""
import json, os, shutil, sys
import numpy as np
import pandas as pd

SRC = "nyc_taxi_weather_hourly.csv"
OUT = "src/data"
os.makedirs(OUT, exist_ok=True)

WANT = [
    "pickup_hour", "PULocationID", "trip_count", "avg_fare", "avg_total_amount",
    "avg_trip_distance", "avg_passenger_count", "total_revenue", "avg_tip_amount",
    "avg_trip_duration_min", "temperature_2m", "apparent_temperature",
    "relative_humidity_2m", "precipitation", "rain", "snowfall", "weather_code",
    "wind_speed_10m", "wind_gusts_10m", "cloud_cover", "hour_of_day", "day_of_week",
    "is_weekend", "month", "day_of_month",
]

print("reading", SRC, flush=True)
df = pd.read_csv(SRC, usecols=WANT,
                 dtype={"pickup_hour": "string", "PULocationID": "int32",
                        "weather_code": "int16", "hour_of_day": "int8",
                        "day_of_week": "int8", "month": "int8", "day_of_month": "int8",
                        "is_weekend": "bool"})
df["pickup_hour"] = pd.to_datetime(df["pickup_hour"])
print("rows", len(df), "hours", df.pickup_hour.nunique(), flush=True)

tc = df.trip_count.to_numpy(np.int64)
zid = df.PULocationID.to_numpy(np.int32)
zones = np.unique(zid)
NZ = len(zones)
print("zones", NZ, flush=True)

# ---------------------------------------------------------------- citywide hour
# Trip-weighted aggregation of the per-(hour, zone) means.
g = df.groupby("pickup_hour", sort=True)
W = ["avg_fare", "avg_total_amount", "avg_trip_distance", "avg_passenger_count",
     "avg_tip_amount", "avg_trip_duration_min"]


def wavg(frame, col):
    return np.average(frame[col].to_numpy(np.float64),
                      weights=frame.trip_count.to_numpy(np.float64))


city = pd.DataFrame({
    "trips": g.trip_count.sum(),
    "revenue": g.total_revenue.sum(),
    "fare": g.apply(wavg, "avg_fare"),
    "amount": g.apply(wavg, "avg_total_amount"),
    "dist": g.apply(wavg, "avg_trip_distance"),
    "pax": g.apply(wavg, "avg_passenger_count"),
    "tip": g.apply(wavg, "avg_tip_amount"),
    "dur": g.apply(wavg, "avg_trip_duration_min"),
}).reset_index()

# Weather is one citywide grid reading per hour; take it as given and verify it is constant.
wc = df.groupby("pickup_hour")[["temperature_2m", "apparent_temperature",
                                 "relative_humidity_2m", "precipitation", "rain",
                                 "snowfall", "weather_code", "wind_speed_10m",
                                 "wind_gusts_10m", "cloud_cover"]].nunique().max().max()
print("max distinct weather values within one hour (expect 1):", wc, flush=True)

w = df.groupby("pickup_hour", sort=True)[["temperature_2m", "apparent_temperature",
                                          "relative_humidity_2m", "precipitation",
                                          "rain", "snowfall", "weather_code",
                                          "wind_speed_10m", "wind_gusts_10m",
                                          "cloud_cover"]].first().reset_index()
city = city.merge(w, on="pickup_hour", how="left")

full = pd.date_range("2025-01-01", "2025-12-31 23:00", freq="h")
missing = full.difference(city.pickup_hour)
print("missing hours:", list(missing), flush=True)

city["doy"] = city.pickup_hour.dt.dayofyear.astype(np.int16)
city["hod"] = city.pickup_hour.dt.hour.astype(np.int8)
city["dow"] = city.pickup_hour.dt.dayofweek.astype(np.int8)
city["mon"] = city.pickup_hour.dt.month.astype(np.int8)
city = city.sort_values("pickup_hour").reset_index(drop=True)
N = len(city)

# ------------------------------------------------------------- derived buckets
PRCP = city.precipitation.to_numpy(np.float64)
city["wet"] = (PRCP > 0).astype(np.int8)
city["wet_class"] = np.select(
    [PRCP <= 0, PRCP < 1.0, PRCP < 4.0], ["dry", "light", "moderate"], "heavy")
city["snowing"] = (city.snowfall > 0).astype(np.int8)
city["temp_band"] = pd.cut(city.temperature_2m, [-99, -5, 0, 5, 10, 15, 20, 25, 30, 99],
                           labels=["<−5", "−5–0", "0–5", "5–10", "10–15", "15–20",
                                   "20–25", "25–30", ">30"]).astype(str)
city["cloud_band"] = pd.cut(city.cloud_cover, [-1, 20, 50, 80, 101],
                            labels=["clear", "part", "mostly", "overcast"]).astype(str)
city["weekend"] = (city.dow >= 5).astype(np.int8)

# Class vocabularies, ordered for stable indexing into the cube axes.
wx_codes = np.sort(city.weather_code.unique())
wx_map = {int(c): i for i, c in enumerate(wx_codes)}
tbands = sorted(city.temp_band.unique())
tb_map = {b: i for i, b in enumerate(tbands)}
MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
               "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
DOW_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]

# --------------------------------------------------------------- zone indexing
zidx = {int(z): i for i, z in enumerate(zones)}
zi = df.PULocationID.map(zidx).to_numpy(np.int32)
trips = tc.astype(np.float64)
rev = df.total_revenue.to_numpy(np.float64)


def cube(keys):
    """Trip- and revenue-summed cube indexed by zone then the supplied keys.

    Keys are applied as little-endian mixed radix: the first key is the slowest
    varying dimension, so the last key must be the one whose range equals the
    innermost axis.
    """
    dims = [int(k.max()) + 1 for k in keys]
    n = int(np.prod(dims))
    nt = np.zeros(NZ * n); nr = np.zeros(NZ * n)
    flat = np.zeros(len(df), dtype=np.int64)
    for k, d in zip(keys, dims):
        flat = flat * d + k.astype(np.int64)
    flat = zi.astype(np.int64) * n + flat
    np.add.at(nt, flat, trips)
    np.add.at(nr, flat, rev)
    return nt.reshape(NZ, *dims), nr.reshape(NZ, *dims)


# Row-level calendar keys (one per CSV row), for the zone cubes.
tsr = df.pickup_hour
k_hod = tsr.dt.hour.to_numpy(np.int64)
k_dow = tsr.dt.dayofweek.to_numpy(np.int64)
k_mon = tsr.dt.month.to_numpy(np.int64) - 1
# Weather class and temp band are per-hour; broadcast the hour-level label to rows.
hour_wx = city.weather_code.to_numpy()[np.searchsorted(city.pickup_hour.astype("int64").to_numpy(), tsr.astype("int64").to_numpy())]
hour_tb = city.temp_band.to_numpy()[np.searchsorted(city.pickup_hour.astype("int64").to_numpy(), tsr.astype("int64").to_numpy())]

z_wx = np.vectorize(wx_map.get)(hour_wx).astype(np.int64)
z_tb = np.vectorize(tb_map.get)(hour_tb).astype(np.int64)

print("building zone cubes...", flush=True)
c_hod, r_hod = cube([k_hod])
c_dow, r_dow = cube([k_dow])
c_mon, r_mon = cube([k_mon])
c_wx, r_wx = cube([z_wx])
c_tb, r_tb = cube([z_tb])
c_mh, r_mh = cube([k_mon, k_hod])
c_dh, r_dh = cube([k_dow, k_hod])

# --------------------------------------------------------------- zone metadata
wcols = ["avg_fare", "avg_total_amount", "avg_trip_distance", "avg_passenger_count",
         "avg_tip_amount", "avg_trip_duration_min"]
zmeta = pd.DataFrame({"z": zid, "t": trips, "r": rev})
for c in wcols:
    zmeta["w_" + c] = df[c].to_numpy(np.float64) * trips
zone_rows = []
for z, row in zmeta.groupby("z", sort=True).sum().iterrows():
    i = zidx[int(z)]
    tot = float(row["t"])
    zone_rows.append({
        "id": int(z), "trips": int(round(tot)), "revenue": int(round(row["r"])),
        "fare": round(float(row["w_avg_fare"]) / tot, 2),
        "amount": round(float(row["w_avg_total_amount"]) / tot, 2),
        "dist": round(float(row["w_avg_trip_distance"]) / tot, 2),
        "pax": round(float(row["w_avg_passenger_count"]) / tot, 2),
        "tip": round(float(row["w_avg_tip_amount"]) / tot, 2),
        "dur": round(float(row["w_avg_trip_duration_min"]) / tot, 1),
        "peakHour": int(np.argmax(c_hod[i])),
        "peakMonth": int(np.argmax(c_mon[i])),
        "peakDow": int(np.argmax(c_dow[i])),
    })
zone_rows.sort(key=lambda r: -r["trips"])

# ------------------------------------------------------------------------ emit
def r1(a):
    return [round(float(x), 1) for x in a]


def nest(a):
    """Recursively convert an n-dim int array to nested Python lists."""
    a = np.asarray(a)
    if a.ndim == 1:
        return [int(v) for v in a]
    return [nest(row) for row in a]


citywide = {
    "n": N,
    "hoursMissing": [str(m) for m in missing],
    "doy": [int(x) for x in city.doy],
    "trips": [int(x) for x in city.trips],
    "revenue": [int(round(x)) for x in city.revenue],
    "fare": [round(float(x), 2) for x in city.fare],
    "amount": [round(float(x), 2) for x in city.amount],
    "dist": [round(float(x), 2) for x in city.dist],
    "pax": [round(float(x), 2) for x in city.pax],
    "tip": [round(float(x), 2) for x in city.tip],
    "dur": [round(float(x), 1) for x in city.dur],
    "temp": r1(city.temperature_2m), "app": r1(city.apparent_temperature),
    "hum": [int(x) for x in city.relative_humidity_2m],
    "prcp": r1(city.precipitation), "snow": r1(city.snowfall),
    "wind": r1(city.wind_speed_10m), "gust": r1(city.wind_gusts_10m),
    "cloud": [int(x) for x in city.cloud_cover],
    "wx": [int(x) for x in city.weather_code],
    "hod": city.hod.tolist(), "dow": city.dow.tolist(), "mon": city.mon.tolist(),
    "wet": city.wet.tolist(),
    "snowing": city.snowing.tolist(),
}
with open(f"{OUT}/citywide.json", "w") as f:
    json.dump(citywide, f, separators=(",", ":"))

zones_out = {
    "wxCodes": [int(c) for c in wx_codes],
    "tempBands": tbands,
    "rows": zone_rows,
    "hHour": [int(v) for v in c_hod.sum(0)], "rHour": [int(v) for v in r_hod.sum(0)],
    "hDow": [int(v) for v in c_dow.sum(0)], "rDow": [int(v) for v in r_dow.sum(0)],
    "hMonth": [int(v) for v in c_mon.sum(0)], "rMonth": [int(v) for v in r_mon.sum(0)],
    "zHod": nest(c_hod),
    "zDow": nest(c_dow),
    "zMonth": nest(c_mon),
    "zMonthR": nest(r_mon),
    "zWx": nest(c_wx),
    "zTemp": nest(c_tb),
    "zMhT": nest(c_mh),
    "zMhR": nest(r_mh),
    "zDhT": nest(c_dh),
    "zDhR": nest(r_dh),
}
with open(f"{OUT}/zones.json", "w") as f:
    json.dump(zones_out, f, separators=(",", ":"))

# These two files are kept as a reproducible record of the aggregation; the
# dashboard itself reads the same numbers from MongoDB via the loader.
for p in ("citywide.json", "zones.json"):
    print(p, round(os.path.getsize(f"{OUT}/{p}") / 1e6, 2), "MB -> src/data")
print("done")
