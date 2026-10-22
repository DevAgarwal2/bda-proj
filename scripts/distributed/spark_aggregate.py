#!/usr/bin/env python3
"""PySpark aggregation stage (the "analysis" stage of the distributed pipeline).

Reads the normalised fact table the MapReduce job wrote to HDFS and produces the
same two payloads as the fast pandas path (scripts/aggregate.py):

    build/distributed/spark-data/citywide.json   the 8,759-hour citywide master series
    build/distributed/spark-data/zones.json      262 zone profiles + the joint cubes

The heavy lifting - the trip-weighted per-hour series and every (zone x dimension)
cube - runs as Spark DataFrame aggregations over the HDFS fact table. Only the final
JSON assembly happens on the driver, so the output can be checked field-for-field
against the pandas build by scripts/distributed/verify.py.

Run with scripts/distributed/run-spark.sh (sets SPARK_HOME, HDFS, PYSPARK_PYTHON).
"""
import json
import os

from pyspark.sql import SparkSession, functions as F, types as T

HDFS_URI = os.environ.get("HDFS_URI", "hdfs://localhost:9000")
HDFS_ROOT = os.environ.get("HDFS_ROOT", "/nyc_taxi")
OUT = os.environ.get("SPARK_OUT", "build/distributed/spark-data")
FACT = f"{HDFS_ROOT}/fact"

# ---------------------------------------------------------------- schema (fact TSV)
SCHEMA = T.StructType([
    T.StructField("hour", T.StringType()),
    T.StructField("zone", T.IntegerType()),
    T.StructField("trip_count", T.IntegerType()),
    T.StructField("total_revenue", T.DoubleType()),
    T.StructField("dropoff_count", T.IntegerType()),
    T.StructField("avg_fare", T.DoubleType()),
    T.StructField("avg_total_amount", T.DoubleType()),
    T.StructField("avg_trip_distance", T.DoubleType()),
    T.StructField("avg_passenger_count", T.DoubleType()),
    T.StructField("avg_tip_amount", T.DoubleType()),
    T.StructField("avg_trip_duration_min", T.DoubleType()),
    T.StructField("temperature_2m", T.DoubleType()),
    T.StructField("apparent_temperature", T.DoubleType()),
    T.StructField("relative_humidity_2m", T.IntegerType()),
    T.StructField("precipitation", T.DoubleType()),
    T.StructField("rain", T.DoubleType()),
    T.StructField("snowfall", T.DoubleType()),
    T.StructField("weather_code", T.IntegerType()),
    T.StructField("wind_speed_10m", T.DoubleType()),
    T.StructField("wind_gusts_10m", T.DoubleType()),
    T.StructField("cloud_cover", T.IntegerType()),
    T.StructField("hour_of_day", T.IntegerType()),
    T.StructField("day_of_week", T.IntegerType()),
    T.StructField("is_weekend", T.StringType()),
    T.StructField("month", T.IntegerType()),
    T.StructField("day_of_month", T.IntegerType()),
])

MEANS = ["avg_fare", "avg_total_amount", "avg_trip_distance", "avg_passenger_count",
         "avg_tip_amount", "avg_trip_duration_min"]
WEATHER = ["temperature_2m", "apparent_temperature", "relative_humidity_2m",
           "precipitation", "rain", "snowfall", "weather_code",
           "wind_speed_10m", "wind_gusts_10m", "cloud_cover"]

TEMP_BINS = [-99, -5, 0, 5, 10, 15, 20, 25, 30, 99]
TEMP_LABELS = ["<\u22125", "\u22125\u20130", "0\u20135", "5\u201310", "10\u201315",
               "15\u201320", "20\u201325", "25\u201330", ">30"]







def cut(value, bins, labels):
    """Replicate pandas.cut(right=True, include_lowest=False): bins are (a, b]."""
    if value is None:
        return None
    if value <= bins[0] or value > bins[-1]:
        return None
    for i, lab in enumerate(labels):
        if bins[i] < value <= bins[i + 1]:
            return lab
    return None


def flat_index(keys, dims):
    flat = 0
    for k, d in zip(keys, dims):
        flat = flat * d + int(k)
    return flat


def nest(flat, dims, nz):
    """Reshape a flat (nz, *dims) little-endian array into nested Python lists."""
    out = []
    for z in range(nz):
        base = z * _prod(dims)
        chunk = flat[base:base + _prod(dims)]
        out.append(_nest_dim(chunk, dims))
    return out


def _prod(xs):
    p = 1
    for x in xs:
        p *= x
    return p


def _nest_dim(flat, dims):
    if len(dims) == 1:
        return [int(v) for v in flat]
    step = _prod(dims[1:])
    return [_nest_dim(flat[i * step:(i + 1) * step], dims[1:]) for i in range(dims[0])]


def main():
    spark = (SparkSession.builder
             .appName("nyc-taxi-weather-aggregate")
             .config("spark.hadoop.fs.defaultFS", HDFS_URI)
             .config("spark.sql.shuffle.partitions", "8")
             .config("spark.ui.showConsoleProgress", "false")
             .getOrCreate())
    spark.sparkContext.setLogLevel("WARN")

    df = spark.read.csv(FACT, schema=SCHEMA, sep="\t")
    df = (df
          .withColumn("ts", F.to_timestamp("hour", "yyyy-MM-dd HH:mm:ss"))
          .withColumn("hod", F.hour("ts"))
          .withColumn("dow", ((F.dayofweek("ts") + 5) % 7))          # pandas: Mon=0
          .withColumn("mon0", (F.month("ts") - 1))                   # pandas: Jan=0
          .withColumn("doy", F.dayofyear("ts"))
          .cache())

    n_rows = df.count()
    print(f"fact rows read from HDFS: {n_rows:,}", flush=True)

    # ------------------------------------------------ citywide hourly master series
    wmean = [ (F.sum(F.col(m) * F.col("trip_count")) / F.sum("trip_count")).alias(m)
              for m in MEANS ]
    wfirst = [F.first(c, ignorenulls=True).alias(c) for c in WEATHER]

    city = (df.groupBy("ts")
            .agg(F.sum("trip_count").alias("trips"),
                 F.sum("total_revenue").alias("revenue"),
                 *wmean, *wfirst)
            .orderBy("ts")
            .collect())

    n_hours = len(city)
    print(f"distinct hours: {n_hours:,}", flush=True)

    # derived per-hour buckets (identical to aggregate.py's city frame)
    citywide = {
        "n": n_hours,
        "doy": [], "trips": [], "revenue": [], "fare": [], "amount": [], "dist": [],
        "pax": [], "tip": [], "dur": [], "temp": [], "app": [], "hum": [], "prcp": [],
        "snow": [], "wind": [], "gust": [], "cloud": [], "wx": [], "hod": [], "dow": [],
        "mon": [], "wet": [], "snowing": [],
    }
    present = set()
    temp_bands_seen = set()
    for r in city:
        ts = r["ts"]
        present.add(ts.strftime("%Y-%m-%d %H:%M:%S"))
        band = cut(r["temperature_2m"], TEMP_BINS, TEMP_LABELS)
        temp_bands_seen.add(band)
        citywide["doy"].append(ts.timetuple().tm_yday)
        citywide["trips"].append(int(r["trips"]))
        citywide["revenue"].append(int(round(r["revenue"])))
        citywide["fare"].append(round(r["avg_fare"], 2))
        citywide["amount"].append(round(r["avg_total_amount"], 2))
        citywide["dist"].append(round(r["avg_trip_distance"], 2))
        citywide["pax"].append(round(r["avg_passenger_count"], 2))
        citywide["tip"].append(round(r["avg_tip_amount"], 2))
        citywide["dur"].append(round(r["avg_trip_duration_min"], 1))
        citywide["temp"].append(round(r["temperature_2m"], 1))
        citywide["app"].append(round(r["apparent_temperature"], 1))
        citywide["hum"].append(int(r["relative_humidity_2m"]))
        citywide["prcp"].append(round(r["precipitation"], 1))
        citywide["snow"].append(round(r["snowfall"], 1))
        citywide["wind"].append(round(r["wind_speed_10m"], 1))
        citywide["gust"].append(round(r["wind_gusts_10m"], 1))
        citywide["cloud"].append(int(r["cloud_cover"]))
        citywide["wx"].append(int(r["weather_code"]))
        citywide["hod"].append(ts.hour)
        citywide["dow"].append((ts.weekday()))                 # Mon=0
        citywide["mon"].append(ts.month)
        citywide["wet"].append(1 if r["precipitation"] > 0 else 0)
        citywide["snowing"].append(1 if r["snowfall"] > 0 else 0)

    # hoursMissing: every hour of 2025 that is absent (the DST spring-forward hour)
    import datetime as dt
    full = []
    cur = dt.datetime(2025, 1, 1, 0)
    end = dt.datetime(2025, 12, 31, 23)
    while cur <= end:
        full.append(cur)
        cur += dt.timedelta(hours=1)
    citywide["hoursMissing"] = [m.strftime("%Y-%m-%d %H:%M:%S")
                                for m in full if m.strftime("%Y-%m-%d %H:%M:%S") not in present]

    # class vocabularies, ordered exactly as aggregate.py orders them
    wx_codes = sorted({int(r["weather_code"]) for r in city})
    wx_map = {c: i for i, c in enumerate(wx_codes)}
    bands_seen = {b for b in temp_bands_seen if b is not None}
    tbands = sorted(bands_seen)
    tb_map = {b: i for i, b in enumerate(tbands)}

    wx_index = F.udf(lambda c: wx_map.get(int(c), -1), T.IntegerType())
    tb_index = F.udf(lambda t: tb_map.get(cut(t, TEMP_BINS, TEMP_LABELS), -1), T.IntegerType())
    df = (df
          .withColumn("wx_idx", wx_index(F.col("weather_code")))
          .withColumn("tb_idx", tb_index(F.col("temperature_2m"))))

    # ------------------------------------------------------------------ zone indices
    zones_sorted = [r["zone"] for r in df.select("zone").distinct().orderBy("zone").collect()]
    nz = len(zones_sorted)
    zpos = {z: i for i, z in enumerate(zones_sorted)}

    # ------------------------------------------------------------- per-zone profiles
    zone_rows_df = (df.groupBy("zone")
                    .agg(F.sum("trip_count").alias("trips"),
                         F.sum("total_revenue").alias("revenue"),
                         *[(F.sum(F.col(m) * F.col("trip_count"))).alias("w_" + m) for m in MEANS])
                    .orderBy("zone").collect())

    # joint cubes: (zone x dimension) sums of trips and revenue
    def cube(keys, dims):
        agg = (df.groupBy("zone", *keys)
               .agg(F.sum("trip_count").alias("t"), F.sum("total_revenue").alias("r"))
               .collect())
        size = _prod(dims)
        nt = [0] * (nz * size)
        nr = [0.0] * (nz * size)   # revenue stays float; pandas truncates on emit
        for row in agg:
            i = zpos[row["zone"]]
            flat = flat_index([row[k] for k in keys], dims)
            nt[i * size + flat] = int(row["t"])
            nr[i * size + flat] += float(row["r"])
        return nt, nr

    print("building zone cubes in Spark...", flush=True)
    c_hod, r_hod = cube(["hod"], [24])
    c_dow, r_dow = cube(["dow"], [7])
    c_mon, r_mon = cube(["mon0"], [12])
    c_wx, r_wx = cube(["wx_idx"], [len(wx_codes)])
    c_tb, r_tb = cube(["tb_idx"], [len(tbands)])
    c_mh, r_mh = cube(["mon0", "hod"], [12, 24])
    c_dh, r_dh = cube(["dow", "hod"], [7, 24])

    # --------------------------------------------------------------- zone_more rows
    zprof = {int(r["zone"]): r for r in zone_rows_df}
    rows = []
    for z in zones_sorted:
        i = zpos[z]
        r = zprof[z]
        tot = float(r["trips"])
        rows.append({
            "id": int(z), "trips": int(round(tot)), "revenue": int(round(r["revenue"])),
            "fare": round(float(r["w_avg_fare"]) / tot, 2),
            "amount": round(float(r["w_avg_total_amount"]) / tot, 2),
            "dist": round(float(r["w_avg_trip_distance"]) / tot, 2),
            "pax": round(float(r["w_avg_passenger_count"]) / tot, 2),
            "tip": round(float(r["w_avg_tip_amount"]) / tot, 2),
            "dur": round(float(r["w_avg_trip_duration_min"]) / tot, 1),
            "peakHour": int(max(range(24), key=lambda h: c_hod[i * 24 + h])),
            "peakMonth": int(max(range(12), key=lambda m: c_mon[i * 12 + m])),
            "peakDow": int(max(range(7), key=lambda d: c_dow[i * 7 + d])),
        })
    rows.sort(key=lambda r: -r["trips"])

    zones_out = {
        "wxCodes": [int(c) for c in wx_codes],
        "tempBands": tbands,
        "rows": rows,
        "hHour": [int(v) for v in _sum_axis(c_hod, nz, [24], 0)],
        "rHour": [int(v) for v in _sum_axis(r_hod, nz, [24], 0)],
        "hDow": [int(v) for v in _sum_axis(c_dow, nz, [7], 0)],
        "rDow": [int(v) for v in _sum_axis(r_dow, nz, [7], 0)],
        "hMonth": [int(v) for v in _sum_axis(c_mon, nz, [12], 0)],
        "rMonth": [int(v) for v in _sum_axis(r_mon, nz, [12], 0)],
        "zHod": nest(c_hod, [24], nz),
        "zDow": nest(c_dow, [7], nz),
        "zMonth": nest(c_mon, [12], nz),
        "zMonthR": nest(r_mon, [12], nz),
        "zWx": nest(c_wx, [len(wx_codes)], nz),
        "zTemp": nest(c_tb, [len(tbands)], nz),
        "zMhT": nest(c_mh, [12, 24], nz),
        "zMhR": nest(r_mh, [12, 24], nz),
        "zDhT": nest(c_dh, [7, 24], nz),
        "zDhR": nest(r_dh, [7, 24], nz),
    }

    os.makedirs(OUT, exist_ok=True)
    with open(f"{OUT}/citywide.json", "w") as f:
        json.dump(citywide, f, separators=(",", ":"))
    with open(f"{OUT}/zones.json", "w") as f:
        json.dump(zones_out, f, separators=(",", ":"))

    print(f"wrote {OUT}/citywide.json ({n_hours:,} hours)", flush=True)
    print(f"wrote {OUT}/zones.json ({nz} zones, {len(wx_codes)} weather codes, "
          f"{len(tbands)} temp bands)", flush=True)
    spark.stop()


def _sum_axis(flat, nz, dims, axis):
    """Sum a flat (nz, *dims) cube over the zone axis -> a flat dims array."""
    size = _prod(dims)
    out = [0] * size
    for z in range(nz):
        for j in range(size):
            out[j] += flat[z * size + j]
    return out


if __name__ == "__main__":
    main()
