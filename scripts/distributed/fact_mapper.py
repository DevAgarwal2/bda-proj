#!/usr/bin/env python3
"""Hadoop Streaming mapper - NYC taxi x weather fact-table normalisation.

Input : one CSV line of the raw extract (header line is skipped; the line's first
        field is the timestamp, so any split can be parsed without the header).
Output: `pickup_hour|PULocationID \t <pipe-joined metrics>`

The mapper does no aggregation. It parses and re-keys, so the shuffle groups every
record for a given (hour, zone) onto one reducer, which is where the normalisation
(and, for duplicated keys, the trip-weighted merge) happens.
"""
import sys

# Column order of the source extract (see README -> Data).
COLS = [
    "pickup_hour", "PULocationID", "trip_count", "avg_fare", "avg_total_amount",
    "avg_trip_distance", "avg_passenger_count", "total_revenue", "avg_tip_amount",
    "avg_trip_duration_min", "dropoff_count", "temperature_2m", "apparent_temperature",
    "relative_humidity_2m", "precipitation", "rain", "snowfall", "weather_code",
    "wind_speed_10m", "wind_gusts_10m", "cloud_cover", "hour_of_day", "day_of_week",
    "is_weekend", "month", "day_of_month",
]
# Metrics carried to the reducer, in reducer-output order.
METRICS = [
    "trip_count", "total_revenue", "dropoff_count",
    "avg_fare", "avg_total_amount", "avg_trip_distance", "avg_passenger_count",
    "avg_tip_amount", "avg_trip_duration_min",
    "temperature_2m", "apparent_temperature", "relative_humidity_2m",
    "precipitation", "rain", "snowfall", "weather_code",
    "wind_speed_10m", "wind_gusts_10m", "cloud_cover",
    "hour_of_day", "day_of_week", "is_weekend", "month", "day_of_month",
]


def main() -> None:
    for line in sys.stdin:
        line = line.rstrip("\n")
        if not line:
            continue
        parts = line.split(",")
        if len(parts) != len(COLS):
            # header line (or a malformed row) - drop it
            continue
        row = dict(zip(COLS, parts))
        ts = row["pickup_hour"]
        if not ts[:4].isdigit():
            continue  # header
        key = f"{ts}|{row['PULocationID']}"
        sys.stdout.write(key + "\t" + "|".join(row[m] for m in METRICS) + "\n")


if __name__ == "__main__":
    main()
