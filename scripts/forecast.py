"""Forecast citywide hourly taxi demand.

Model: ridge regression on log1p(trips) with calendar + weather + lag features.
Split: the last 56 days (2025-11-06 → 2025-12-31) are held out; everything before
is training. The baseline is the seasonal-naive forecast (same hour, same weekday,
previous week), which the model must beat to be worth anything.

Outputs src/data/forecast.json, read by /api/forecast and the /forecast page.

Run:  python3 scripts/forecast.py
"""
import json
import math
from datetime import datetime, timezone

import numpy as np
import pandas as pd

SRC = "src/data/citywide.json"
OUT = "src/data/forecast.json"
ALPHA = 1.0
TEST_DAYS = 56
FEATURES = [
    "hod_sin", "hod_cos", "dow_sin", "dow_cos", "doy_sin", "doy_cos", "weekend",
    "temp", "prcp", "snow", "hum", "wind", "cloud",
    "lag24", "lag168", "roll24",
]

c = json.load(open(SRC))

# ---------------------------------------------------------------- hourly frame
ts = (pd.to_datetime("2025-01-01")
      + pd.to_timedelta(np.asarray(c["doy"], dtype="int64") - 1, "D")
      + pd.to_timedelta(np.asarray(c["hod"], dtype="int64"), "h"))

df = pd.DataFrame({
    "ts": ts,
    "trips": np.asarray(c["trips"], dtype="float64"),
    "temp": np.asarray(c["temp"], dtype="float64"),
    "prcp": np.asarray(c["prcp"], dtype="float64"),
    "snow": np.asarray(c["snow"], dtype="float64"),
    "hum": np.asarray(c["hum"], dtype="float64"),
    "wind": np.asarray(c["wind"], dtype="float64"),
    "cloud": np.asarray(c["cloud"], dtype="float64"),
}).set_index("ts").sort_index()

# A dense hourly index. 2025-03-09 02:00 is absent (DST), so interpolate that one
# hour for feature history while leaving the target missing.
full = pd.date_range("2025-01-01 00:00", "2025-12-31 23:00", freq="h")
df = df.reindex(full)
wx = ["temp", "prcp", "snow", "hum", "wind", "cloud"]
df[wx] = df[wx].interpolate().ffill().bfill()
hist = df["trips"].interpolate()


def cyclic(values, period):
    a = 2 * math.pi * np.asarray(values, dtype="float64") / period
    return np.sin(a), np.cos(a)


hod = df.index.hour.to_numpy()
dow = df.index.dayofweek.to_numpy()
doy = df.index.dayofyear.to_numpy()
hod_sin, hod_cos = cyclic(hod, 24)
dow_sin, dow_cos = cyclic(dow, 7)
doy_sin, doy_cos = cyclic(doy, 365.25)

df["hod_sin"], df["hod_cos"] = hod_sin, hod_cos
df["dow_sin"], df["dow_cos"] = dow_sin, dow_cos
df["doy_sin"], df["doy_cos"] = doy_sin, doy_cos
df["weekend"] = (dow >= 5).astype(float)
# Lags live on the same log scale as the target, so the model can learn
# log(trips_t) ~ log(trips_{t-1 week}) instead of fitting a curve.
hlog = np.log1p(hist)
df["lag24"] = hlog.shift(24)
df["lag168"] = hlog.shift(168)
df["roll24"] = hlog.shift(1).rolling(24).mean()
df["y"] = np.log1p(df["trips"])

# -------------------------------------------------------------- train / test
test_start = pd.Timestamp("2025-12-31 23:00") - pd.Timedelta(days=TEST_DAYS) + pd.Timedelta(hours=1)
train = df.index < test_start
test = df.index >= test_start

train = train & df[FEATURES + ["y"]].notna().all(axis=1)
test = test & df[FEATURES + ["y"]].notna().all(axis=1)

mu = df.loc[train, FEATURES].mean()
sd = df.loc[train, FEATURES].std().replace(0, 1.0)

Xtr = np.column_stack([np.ones(train.sum()), ((df.loc[train, FEATURES] - mu) / sd).to_numpy()])
ytr = df.loc[train, "y"].to_numpy()
pen = ALPHA * np.eye(Xtr.shape[1])
pen[0, 0] = 0.0
beta = np.linalg.solve(Xtr.T @ Xtr + pen, Xtr.T @ ytr)

Xte = np.column_stack([np.ones(test.sum()), ((df.loc[test, FEATURES] - mu) / sd).to_numpy()])
pred_log = Xte @ beta
pred = np.maximum(0.0, np.expm1(pred_log))
actual = df.loc[test, "trips"].to_numpy()
base = np.expm1(df.loc[test, "lag168"].to_numpy())


def metrics(y, p):
    e = y - p
    mae = float(np.mean(np.abs(e)))
    rmse = float(np.sqrt(np.mean(e ** 2)))
    mape = float(np.mean(np.abs(e / np.where(y == 0, np.nan, y))) * 100)
    ss_res = float(np.sum(e ** 2))
    ss_tot = float(np.sum((y - y.mean()) ** 2))
    r2 = 1 - ss_res / ss_tot if ss_tot else 0.0
    return {"mae": round(mae, 1), "rmse": round(rmse, 1),
            "mape": round(mape, 2), "r2": round(r2, 4)}


m_model = metrics(actual, pred)
m_base = metrics(actual, base)
improvement = 100 * (m_base["mae"] - m_model["mae"]) / m_base["mae"]

# ------------------------------------------------------- next 7 days forecast
future = pd.date_range("2026-01-01 00:00", "2026-01-07 23:00", freq="h")
weather_fill = {k: float(df[k].iloc[-30 * 24:].mean()) for k in wx}
ext = pd.Series(index=hist.index.append(future), dtype="float64")
ext.loc[hist.index] = hist.to_numpy()

next_rows = []
for t in future:
    hs, hc = cyclic([t.hour], 24)
    ds, dc = cyclic([t.dayofweek], 7)
    ys, yc = cyclic([t.dayofyear], 365.25)
    row = {
        "hod_sin": hs[0], "hod_cos": hc[0],
        "dow_sin": ds[0], "dow_cos": dc[0],
        "doy_sin": ys[0], "doy_cos": yc[0],
        "weekend": 1.0 if t.dayofweek >= 5 else 0.0,
        **weather_fill,
        "lag24": float(np.log1p(ext.loc[t - pd.Timedelta(hours=24)])),
        "lag168": float(np.log1p(ext.loc[t - pd.Timedelta(hours=168)])),
        "roll24": float(np.log1p(ext.loc[t - pd.Timedelta(hours=24):t - pd.Timedelta(hours=1)]).mean()),
    }
    x = np.array([1.0] + [row[f] for f in FEATURES])
    x[1:] = (x[1:] - mu.to_numpy()) / sd.to_numpy()
    p = max(0.0, float(np.expm1(x @ beta)))
    ext.loc[t] = p
    next_rows.append({"t": t.strftime("%Y-%m-%dT%H:%M:%S"), "trips": round(p)})

# ------------------------------------------------------------- output shapes
test_df = pd.DataFrame({
    "t": df.index[test],
    "actual": actual,
    "predicted": pred,
    "baseline": base,
})
backtest_daily = (test_df.set_index("t")
                  .resample("D").sum()
                  .reset_index()
                  .rename(columns={"t": "date"}))
backtest = [{
    "date": r.date.strftime("%Y-%m-%d"),
    "actual": int(round(r.actual)),
    "predicted": int(round(r.predicted)),
    "baseline": int(round(r.baseline)),
} for r in backtest_daily.itertuples()]

recent_start = df.index[test][-7 * 24]
recent = [{
    "t": r.t.strftime("%Y-%m-%dT%H:%M:%S"),
    "actual": int(round(r.actual)),
    "predicted": int(round(r.predicted)),
} for r in test_df[test_df.t >= recent_start].itertuples()]

nd = pd.DataFrame(next_rows)
nd["t"] = pd.to_datetime(nd["t"])
nd["date"] = nd["t"].dt.strftime("%Y-%m-%d")
nd["dow"] = nd["t"].dt.dayofweek
next7_daily = (nd.groupby(["date", "dow"], as_index=False)["trips"]
               .sum().sort_values("date"))
next7_daily_out = [{
    "date": r.date,
    "dow": int(r.dow),
    "trips": int(r.trips),
} for r in next7_daily.itertuples()]

# standardised coefficients, ranked — the method page can read these
coefs = sorted(
    ({"feature": f, "coef": round(float(beta[i + 1]), 4)} for i, f in enumerate(FEATURES)),
    key=lambda d: -abs(d["coef"]),
)

out = {
    "generated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    "model": {
        "name": "Ridge regression on log1p(trips)",
        "alpha": ALPHA,
        "target": "trips per hour (citywide)",
        "features": FEATURES,
        "trainRows": int(train.sum()),
        "testRows": int(test.sum()),
        "testStart": test_start.strftime("%Y-%m-%d"),
        "testEnd": "2025-12-31",
        "metrics": {"model": m_model, "baseline": m_base,
                    "improvementPct": round(improvement, 1)},
        "coefficients": coefs,
    },
    "backtest": backtest,
    "recent": recent,
    "next7": next_rows,
    "next7Daily": next7_daily_out,
}

with open(OUT, "w") as fh:
    json.dump(out, fh, separators=(",", ":"))
    fh.write("\n")

print(f"train={train.sum():,}  test={test.sum():,}  ({test_start.date()} -> 2025-12-31)")
print(f"model    MAE={m_model['mae']:,.1f}  RMSE={m_model['rmse']:,.1f}  "
      f"MAPE={m_model['mape']:.2f}%  R2={m_model['r2']:.4f}")
print(f"baseline MAE={m_base['mae']:,.1f}  RMSE={m_base['rmse']:,.1f}  "
      f"MAPE={m_base['mape']:.2f}%  R2={m_base['r2']:.4f}")
print(f"improvement over seasonal naive: {improvement:+.1f}% MAE")
print(f"wrote {OUT}")
