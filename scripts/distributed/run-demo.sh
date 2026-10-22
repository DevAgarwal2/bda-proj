#!/usr/bin/env bash
# Submit the project demo job and make sure the History Server is up, so the run
# is visible both live (:8080 / :4040) and after it finishes (:18080).
#
#   bash scripts/distributed/run-demo.sh
#   HOLD_SECONDS=1800 bash scripts/distributed/run-demo.sh   # hold longer
set -euo pipefail
D="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=env.sh
source "$D/env.sh"

EVENTS="${SPARK_EVENTS_DIR:-$HOME/spark-env/spark-events}"
mkdir -p "$EVENTS"

if ! lsof -nP -iTCP:18080 -sTCP:LISTEN >/dev/null 2>&1; then
  SPARK_HISTORY_OPTS="-Dspark.history.fs.logDirectory=file://$EVENTS -Dspark.history.ui.port=18080" \
    "$SPARK_HOME/sbin/start-history-server.sh" >/dev/null 2>&1 || true
  sleep 2
fi

exec "$SPARK_HOME/bin/spark-submit" \
  --master "${SPARK_MASTER:-spark://localhost:7077}" \
  --conf spark.eventLog.enabled=true \
  --conf spark.eventLog.dir="file://$EVENTS" \
  --conf spark.sql.shuffle.partitions=8 \
  "$D/spark_demo.py"
