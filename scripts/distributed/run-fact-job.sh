#!/usr/bin/env bash
# Stage 2 - Hadoop Streaming MapReduce: normalise the raw extract into the
# (hour x pickup zone) fact table at $HDFS_ROOT/fact.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/env.sh"

hadoop_ok || { echo "hadoop not found at $HADOOP_HOME" >&2; exit 1; }
[ -f "$HADOOP_STREAMING_JAR" ] || { echo "streaming jar missing: $HADOOP_STREAMING_JAR" >&2; exit 1; }

IN="$HDFS_ROOT/raw/$(basename "$SRC_CSV")"
OUT="$HDFS_ROOT/fact"
hdfs dfs -test -e "$IN" || { echo "input not in HDFS: $IN  (run ingest.sh first)" >&2; exit 1; }

hdfs dfs -rm -r -f "$OUT" >/dev/null 2>&1 || true

echo "running MapReduce: raw -> fact  (this reads the whole extract)"
hadoop jar "$HADOOP_STREAMING_JAR" \
  -D mapreduce.job.name="nyc-taxi-fact-normalise" \
  -D mapreduce.job.reduces=4 \
  -D mapreduce.task.timeout=600000 \
  -files "$REPO_ROOT/scripts/distributed/fact_mapper.py,$REPO_ROOT/scripts/distributed/fact_reducer.py" \
  -mapper "python3 fact_mapper.py" \
  -reducer "python3 fact_reducer.py" \
  -input "$IN" \
  -output "$OUT"

echo
echo "fact rows in HDFS:"
hdfs dfs -cat "$OUT/part-*" | wc -l
hdfs dfs -ls -h "$OUT"
