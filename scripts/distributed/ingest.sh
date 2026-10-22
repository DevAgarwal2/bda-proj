#!/usr/bin/env bash
# Stage 1 - land the raw extract in HDFS, the way the README's "raw /taxi" lands.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/env.sh"

if [ ! -f "$SRC_CSV" ]; then
  echo "missing source extract: $SRC_CSV" >&2
  exit 1
fi

hdfs dfs -mkdir -p "$HDFS_ROOT/raw"
if hdfs dfs -test -e "$HDFS_ROOT/raw/$(basename "$SRC_CSV")"; then
  echo "already in HDFS: $HDFS_ROOT/raw/$(basename "$SRC_CSV")  ($(hdfs dfs -du -h "$HDFS_ROOT/raw/$(basename "$SRC_CSV")" | awk '{print $1}'))"
else
  echo "putting $(basename "$SRC_CSV") -> $HDFS_ROOT/raw/"
  hdfs dfs -put "$SRC_CSV" "$HDFS_ROOT/raw/"
fi
hdfs dfs -ls -h "$HDFS_ROOT/raw/"
