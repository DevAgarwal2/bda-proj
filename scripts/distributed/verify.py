#!/usr/bin/env python3
"""Prove the distributed build matches the pandas build.

Compares the Spark output (build/distributed/spark-data, from the HDFS fact table)
against the committed pandas output (src/data) field by field, and exits non-zero
if any field is outside tolerance.

Tolerances exist because the two paths sum float64 values in different orders, so a
value that is rounded for display can land one unit away at a boundary. Integer
counts and every trip cube are required to match exactly; values rounded for display
are allowed their rounding step; revenue aggregates (float sums stored as integers)
are allowed a single unit, because a sum within float noise of a whole number can
round to either neighbour. The report prints the observed max |diff| for every field.
"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PANDAS_DIR = ROOT / "src" / "data"
SPARK_DIR = ROOT / "build" / "distributed" / "spark-data"

INT_FIELDS = {
    "n", "doy", "trips", "revenue", "hum", "cloud", "wx", "hod", "dow", "mon", "wet",
    "snowing", "id", "peakHour", "peakMonth", "peakDow",
    "hHour", "rHour", "hDow", "rDow", "hMonth", "rMonth",
    "zHod", "zDow", "zMonth", "zMonthR", "zWx", "zTemp",
    "zMhT", "zMhR", "zDhT", "zDhR", "wxCodes",
}
F2_FIELDS = {"fare", "amount", "dist", "pax", "tip"}          # rounded to 2 dp
F1_FIELDS = {"dur", "temp", "app", "prcp", "snow", "wind", "gust"}  # rounded to 1 dp
STR_FIELDS = {"hoursMissing", "tempBands"}
# Revenue aggregates are float sums stored as integers. The two engines sum in a
# different order, so a cell can land on the neighbouring integer when the true sum
# is within float noise of a whole number. Allowed to differ by 1; counts never are.
MONEY_FIELDS = {"revenue", "rHour", "rDow", "rMonth", "zMonthR", "zMhR", "zDhR"}

TOL = {"int": 0.0, "money": 1.0, "f2": 0.011, "f1": 0.11, "str": 0.0}


class Report:
    def __init__(self):
        self.fields = {}

    def add(self, name, path, mode, diff):
        e = self.fields.setdefault(name, {"mode": mode, "max": 0.0, "bad": 0, "where": ""})
        if diff > e["max"]:
            e["max"] = diff
            e["where"] = path
        if diff > TOL[mode]:
            e["bad"] += 1


def compare(a, b, name, path, rep):
    if isinstance(a, list):
        if not isinstance(b, list) or len(a) != len(b):
            rep.add(name, path, "int", float("inf"))
            return
        for i, (x, y) in enumerate(zip(a, b)):
            compare(x, y, name, f"{path}[{i}]", rep)
        return
    if isinstance(a, dict):
        for k in a:
            if k not in b:
                rep.add(k, f"{path}.{k}", "int", float("inf"))
            else:
                compare(a[k], b[k], k, f"{path}.{k}", rep)
        return

    if name in STR_FIELDS:
        rep.add(name, path, "str", 0.0 if a == b else 1.0)
        return
    if name in MONEY_FIELDS:
        mode = "money"
    elif name in F2_FIELDS:
        mode = "f2"
    elif name in F1_FIELDS:
        mode = "f1"
    else:
        mode = "int"
    diff = abs(float(a) - float(b))
    rep.add(name, path, mode, diff)


def one(fname):
    pa = PANDAS_DIR / fname
    ps = SPARK_DIR / fname
    if not pa.exists():
        print(f"  ! pandas output missing: {pa}")
        return False
    if not ps.exists():
        print(f"  ! spark output missing: {ps}  (run npm run data:spark)")
        return False
    a = json.loads(pa.read_text())
    b = json.loads(ps.read_text())
    rep = Report()
    for k in a:
        if k in b:
            compare(a[k], b[k], k, fname + "." + k, rep)
        else:
            rep.add(k, fname + "." + k, "int", float("inf"))

    ok = True
    print(f"\n{fname}")
    print(f"  {'field':<12} {'kind':<5} {'max |diff|':>12}  {'out of tol':>10}")
    for name in sorted(rep.fields):
        e = rep.fields[name]
        flag = "" if e["bad"] == 0 else f"   <- {e['where']}"
        if e["bad"]:
            ok = False
        print(f"  {name:<12} {e['mode']:<5} {e['max']:>12.6g}  {e['bad']:>10}{flag}")
    return ok


def main():
    if not SPARK_DIR.exists():
        print(f"no Spark output at {SPARK_DIR}\nrun: npm run data:spark")
        return 2
    print(f"pandas : {PANDAS_DIR}")
    print(f"spark  : {SPARK_DIR}")
    ok_city = one("citywide.json")
    ok_zones = one("zones.json")
    ok = ok_city and ok_zones
    print("\n" + ("PASS - the distributed build reproduces the pandas build: counts and "
                  "trip cubes exact, rounded values within tolerance, money within $1"
                  if ok else "FAIL - see the fields flagged above"))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
