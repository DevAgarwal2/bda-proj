"""Demo job for the project viva.

Reads the project extract from HDFS and runs the dashboard's core aggregations as
Spark SQL, so the Spark Master UI (:8080) and the live App UI (:4040) show real
stages, SQL queries and tasks — not an empty cluster.

The app deliberately stays open for HOLD_SECONDS (default 15 min) after the
queries finish, so it can be demonstrated. Event logging is enabled by the
spark-submit wrapper, so a finished run also appears in the History Server
(:18080).

Run:
    bash scripts/distributed/run-demo.sh
"""
import os
import time

from pyspark.sql import SparkSession

HDFS_URI = os.environ.get("HDFS_URI", "hdfs://localhost:9000")
HDFS_ROOT = os.environ.get("HDFS_ROOT", "/nyc_taxi")
CSV = f"{HDFS_URI}{HDFS_ROOT}/raw/nyc_taxi_weather_hourly.csv"
HOLD = int(os.environ.get("HOLD_SECONDS", "900"))

spark = (
    SparkSession.builder
    .appName("NYC Taxi x Weather - Project Demo")
    .config("spark.sql.shuffle.partitions", "8")
    .getOrCreate()
)
spark.sparkContext.setLogLevel("WARN")

print("=" * 78)
print("NYC TAXI x WEATHER — SPARK DEMO")
print("Master  :", spark.sparkContext.master)
print("App UI  :", spark.sparkContext.uiWebUrl)
print("Input   :", CSV)
print("=" * 78, flush=True)

df = (
    spark.read
    .option("header", "true")
    .option("inferSchema", "true")
    .csv(CSV)
    .repartition(8)
    .cache()
)
df.createOrReplaceTempView("trips")
print(f"rows cached: {df.count():,}", flush=True)


def q(title: str, sql: str) -> None:
    print("\n" + "-" * 78)
    print(title)
    print("-" * 78, flush=True)
    spark.sql(sql).show(30, truncate=False)
    print(flush=True)


q("1. Dataset size", """
    SELECT COUNT(*)              AS rows,
           SUM(trip_count)       AS trips,
           ROUND(SUM(total_revenue), 0) AS revenue
    FROM trips
""")

q("2. Demand by hour of day", """
    SELECT hour_of_day AS hour,
           SUM(trip_count) AS trips,
           ROUND(SUM(trip_count) / COUNT(DISTINCT pickup_hour), 0) AS trips_per_hour
    FROM trips
    GROUP BY hour_of_day
    ORDER BY hour_of_day
""")

q("3. Wet vs dry hours (naive, uncontrolled)", """
    SELECT CASE WHEN precipitation > 0 THEN 'wet' ELSE 'dry' END AS sky,
           SUM(trip_count) AS trips,
           COUNT(DISTINCT pickup_hour) AS hours,
           ROUND(SUM(trip_count) / COUNT(DISTINCT pickup_hour), 0) AS trips_per_hour
    FROM trips
    GROUP BY 1
    ORDER BY 1
""")

q("4. Snow hours", """
    SELECT COUNT(DISTINCT pickup_hour) AS snow_hours,
           SUM(trip_count)             AS trips
    FROM trips
    WHERE snowfall > 0
""")

q("5. Top 10 pickup zones", """
    SELECT PULocationID                    AS zone,
           SUM(trip_count)                 AS trips,
           ROUND(SUM(total_revenue), 0)    AS revenue
    FROM trips
    GROUP BY PULocationID
    ORDER BY trips DESC
    LIMIT 10
""")

q("6. Rain effect inside month x hour cells (controlled, trip-weighted)", """
    SELECT ROUND(SUM(ratio * weight) / SUM(weight), 4) AS controlled_wet_dry_ratio,
           COUNT(*) AS cells
    FROM (
        SELECT (wet_trips / wet_hours) / (dry_trips / dry_hours) AS ratio,
               wet_trips + dry_trips AS weight
        FROM (
            SELECT month, hour_of_day,
                   SUM(CASE WHEN precipitation > 0 THEN trip_count ELSE 0 END) AS wet_trips,
                   SUM(CASE WHEN precipitation = 0 THEN trip_count ELSE 0 END) AS dry_trips,
                   COUNT(DISTINCT CASE WHEN precipitation > 0 THEN pickup_hour END) AS wet_hours,
                   COUNT(DISTINCT CASE WHEN precipitation = 0 THEN pickup_hour END) AS dry_hours
            FROM trips
            GROUP BY month, hour_of_day
        ) cells
        WHERE wet_hours >= 3 AND dry_hours >= 3
    ) ratios
""")

print("\n" + "=" * 78)
print("ALL QUERIES COMPLETE — the app is held open so the UI can be inspected.")
print("Master UI : http://localhost:8080")
print("App UI    : http://localhost:4040")
print(f"Holding for {HOLD} seconds (Ctrl-C to stop early).")
print("=" * 78, flush=True)

time.sleep(HOLD)
spark.stop()
print("stopped")
