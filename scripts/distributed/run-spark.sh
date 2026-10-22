#!/usr/bin/env bash
# Stage 3 - PySpark aggregation. Reads the MapReduce fact table from HDFS, runs
# the same trip-weighted aggregations as scripts/aggregate.py, and writes
# citywide.json + zones.json to $SPARK_OUT (default build/distributed/spark-data).
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/env.sh"

spark_ok || { echo "spark-submit not found at $SPARK_HOME (set SPARK_HOME)" >&2; exit 1; }

if ! hdfs dfs -test -e "$HDFS_ROOT/fact"; then
  echo "no fact table in HDFS at $HDFS_ROOT/fact (run the MapReduce job first)" >&2
  exit 1
fi

mkdir -p "$SPARK_OUT"
echo "spark-submit -> $SPARK_OUT"
spark-submit \
  --master "local[*]" \
  --conf "spark.hadoop.fs.defaultFS=$HDFS_URI" \
  --conf "spark.sql.shuffle.partitions=8" \
  --conf "spark.ui.showConsoleProgress=false" \
  "$REPO_ROOT/scripts/distributed/spark_aggregate.py"

echo
ls -lh "$SPARK_OUT"
