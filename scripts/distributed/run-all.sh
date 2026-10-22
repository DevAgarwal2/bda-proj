#!/usr/bin/env bash
# Full distributed path: HDFS up -> ingest -> MapReduce fact -> PySpark -> verify.
# The fast pandas path (npm run data) stays the default; this proves the cluster
# path produces the same numbers.
set -euo pipefail
D="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$D/env.sh"

bash "$D/hdfs-up.sh"
bash "$D/ingest.sh"
bash "$D/run-fact-job.sh"
bash "$D/run-spark.sh"
"$PYSPARK_PYTHON" "$D/verify.py"
