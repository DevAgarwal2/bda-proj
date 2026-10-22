#!/usr/bin/env bash
# Start the single-node HDFS (NameNode + DataNode) and wait until it leaves safe mode.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/env.sh"

jps | grep -q NameNode || hdfs --daemon start namenode
jps | grep -q DataNode || hdfs --daemon start datanode
jps | grep -q ResourceManager || yarn --daemon start resourcemanager
jps | grep -q NodeManager || yarn --daemon start nodemanager

echo "waiting for HDFS..."
for i in $(seq 1 30); do
  state="$(hdfs dfsadmin -safemode get 2>/dev/null | tr -d '\r' | awk '{print $NF}')"
  if [ "$state" = "OFF" ]; then break; fi
  sleep 1
done

hdfs dfsadmin -report 2>/dev/null | grep -E "^(Configured Capacity|DFS Remaining|Live datanodes)" | head -4
echo "YARN nodes:"
yarn node -list 2>/dev/null | grep -E "RUNNING|Total Nodes" | head -3
echo "cluster up at $HDFS_URI"
