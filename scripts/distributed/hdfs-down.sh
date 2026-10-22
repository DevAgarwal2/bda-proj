#!/usr/bin/env bash
# Stop the single-node HDFS daemons.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/env.sh"

yarn --daemon stop nodemanager 2>/dev/null || true
yarn --daemon stop resourcemanager 2>/dev/null || true
hdfs --daemon stop datanode 2>/dev/null || true
hdfs --daemon stop namenode 2>/dev/null || true
sleep 1
jps | grep -qE "NameNode|DataNode|ResourceManager|NodeManager" && echo "still running:" && jps || echo "cluster stopped"
