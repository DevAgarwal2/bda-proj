#!/usr/bin/env bash
# Shared environment for the distributed (Hadoop + Spark) stages.
#
# The dashboard's fast path is pandas (scripts/aggregate.py, scripts/analyse.py).
# These stages are the *cluster* path that the README describes: land the raw
# extract in HDFS, normalise it with a Hadoop Streaming MapReduce job, then run
# the DataFrame aggregations in PySpark. Output is written separately and checked
# against the pandas output (scripts/distributed/verify.py) before it is trusted.

# Hadoop 3.3.6 and Spark 3.5.x both want Java 8/11; the JDK on PATH may be newer.
if [ -x /opt/homebrew/opt/openjdk@11/libexec/openjdk.jdk/Contents/Home/bin/java ]; then
  export JAVA_HOME="/opt/homebrew/opt/openjdk@11/libexec/openjdk.jdk/Contents/Home"
fi

export HADOOP_HOME="${HADOOP_HOME:-$HOME/hadoop-env/hadoop-3.3.6}"
export SPARK_HOME="${SPARK_HOME:-$HOME/spark-env/spark-3.5.3-bin-hadoop3}"
export HADOOP_CONF_DIR="$HADOOP_HOME/etc/hadoop"

: "${HDFS_URI:=hdfs://localhost:9000}"
: "${HDFS_ROOT:=/nyc_taxi}"
export HDFS_URI HDFS_ROOT

# PySpark 3.5 supports Python 3.8-3.11. The project venv is 3.14, so use the
# system Python that ships with macOS (3.9) for the Spark workers and driver.
: "${PYSPARK_PYTHON:=/usr/bin/python3}"
export PYSPARK_PYTHON
export PYSPARK_DRIVER_PYTHON="$PYSPARK_PYTHON"

export PATH="$SPARK_HOME/bin:$HADOOP_HOME/bin:$HADOOP_HOME/sbin:$PATH"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
export REPO_ROOT
export SRC_CSV="$REPO_ROOT/nyc_taxi_weather_hourly.csv"

# Where the distributed stage writes its output (kept out of src/data so the
# dashboard keeps serving the pandas build until verify.py signs off).
: "${SPARK_OUT:=$REPO_ROOT/build/distributed/spark-data}"
export SPARK_OUT

export HADOOP_STREAMING_JAR="$HADOOP_HOME/share/hadoop/tools/lib/hadoop-streaming-3.3.6.jar"

hadoop_ok() { [ -x "$HADOOP_HOME/bin/hadoop" ]; }
spark_ok() { [ -x "$SPARK_HOME/bin/spark-submit" ]; }
