#!/usr/bin/env python3
"""Hadoop Streaming reducer - collapse each (hour, zone) key to one fact row.

The extract is already one row per (hour, zone), so this is normally an identity
pass. Where a key repeats it is a real reduction: the count-like columns
(`trip_count`, `total_revenue`, `dropoff_count`) are summed, and the per-trip mean
columns are re-weighted by `trip_count` rather than averaged naively. Weather and
calendar fields are constant for the hour and taken from the first record.

Output is a tab-separated fact table; the column order matches the source extract
so PySpark can read it with a fixed schema.
"""
import sys

METRICS = [
    "trip_count", "total_revenue", "dropoff_count",
    "avg_fare", "avg_total_amount", "avg_trip_distance", "avg_passenger_count",
    "avg_tip_amount", "avg_trip_duration_min",
    "temperature_2m", "apparent_temperature", "relative_humidity_2m",
    "precipitation", "rain", "snowfall", "weather_code",
    "wind_speed_10m", "wind_gusts_10m", "cloud_cover",
    "hour_of_day", "day_of_week", "is_weekend", "month", "day_of_month",
]
SUMMED_INT = {"trip_count", "dropoff_count"}
SUMMED_FLOAT = {"total_revenue"}
MEANED = {"avg_fare", "avg_total_amount", "avg_trip_distance", "avg_passenger_count",
          "avg_tip_amount", "avg_trip_duration_min"}


def emit(key, acc, n):
    hour, zone = key.split("|")
    vals = []
    tot = acc["trip_count"]
    for m in METRICS:
        if m in SUMMED_INT:
            vals.append(str(int(round(acc[m]))))
        elif m in SUMMED_FLOAT:
            # full precision - the column carries cents and is summed downstream
            vals.append(repr(acc[m]))
        elif m in MEANED:
            # acc[m] holds sum(mean * trip_count); dividing by the trip total
            # recovers the trip-weighted mean (for one record, the mean itself).
            vals.append(repr(acc[m] / tot))
        else:
            vals.append(str(acc[m]))
    sys.stdout.write("\t".join([hour, zone] + vals) + "\n")


def main() -> None:
    cur = None
    acc = {}
    n = 0
    for line in sys.stdin:
        key, _, payload = line.rstrip("\n").partition("\t")
        vals = payload.split("|")
        if key != cur:
            if cur is not None:
                emit(cur, acc, n)
            cur = key
            acc = {}
            n = 0
        for m, raw in zip(METRICS, vals):
            if m in SUMMED_INT or m in SUMMED_FLOAT:
                acc[m] = acc.get(m, 0.0) + float(raw)
            elif m in MEANED:
                acc[m] = acc.get(m, 0.0) + float(raw) * float(vals[0])
            else:
                acc.setdefault(m, raw)
        n += 1
    if cur is not None:
        emit(cur, acc, n)


if __name__ == "__main__":
    main()
