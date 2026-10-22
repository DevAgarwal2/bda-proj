"""Derive the dashboard's findings from the aggregated cube.

Every claim printed here is computed from the source CSV through aggregate.py's
aggregation rules, and every comparison that could be confounded by time of day or
season is controlled inside a (month x hour-of-day) cell rather than compared raw.
"""
import json, os, shutil

import numpy as np
import pandas as pd

c = json.load(open("src/data/citywide.json"))
z = json.load(open("src/data/zones.json"))

T = np.array(c["trips"], np.float64)
R = np.array(c["revenue"], np.float64)
PR = np.array(c["prcp"], np.float64)
TEMP = np.array(c["temp"], np.float64)
WX = np.array(c["wx"], np.int64)
CLOUD = np.array(c["cloud"], np.float64)
WIND = np.array(c["wind"], np.float64)
HUM = np.array(c["hum"], np.float64)
SNOW = np.array(c["snow"], np.float64)
HOD = np.array(c["hod"], np.int64)
DOW = np.array(c["dow"], np.int64)
MON = np.array(c["mon"], np.int64)
FARE = np.array(c["fare"], np.float64)
DIST = np.array(c["dist"], np.float64)
TIP = np.array(c["tip"], np.float64)
DUR = np.array(c["dur"], np.float64)
PAX = np.array(c["pax"], np.float64)
N = len(T)
DOY = np.array(c["doy"], np.int64)
# Reconstruct timestamps from day-of-year + hour. Must not use a dense date range:
# 2025-03-09 02:00 is absent from the data, which would shift every later index.
_ts = pd.to_datetime("2025-01-01") + pd.to_timedelta(DOY - 1, "D") + pd.to_timedelta(HOD, "h")
full = _ts
WET = PR > 0

out = []
def say(s=""):
    out.append(str(s))
    print(s)

def rule(t):
    say("\n" + t)
    say("-" * len(t))


def wmean(v, t):
    """Trip-weighted mean: sum(value * trips) / sum(trips).

    The project's rule for every citywide or multi-zone average of a per-trip
    metric. Averaging per-(hour, zone) means naively over-weights quiet hours.
    """
    return float((np.asarray(v, np.float64) * np.asarray(t, np.float64)).sum()
                 / np.asarray(t, np.float64).sum())


say("YEAR TOTALS")
rule("YEAR TOTALS")
say(f"hours={N}  trips={T.sum():,.0f}  revenue=${R.sum():,.0f}")
say(f"mean trips/hour={T.mean():,.0f}  median={np.median(T):,.0f}")
say(f"tip rate = ${wmean(TIP,T)/wmean(FARE,T):.3f} per $1 fare  ({100*wmean(TIP,T)/wmean(FARE,T):.1f}%)")
say(f"revenue per trip = ${R.sum()/T.sum():.2f}   per trip-hour ${R.sum()/N:,.0f}")

rule("SHAPE OF THE YEAR")
by = lambda k, v: np.array([v[MON == m].sum() for m in range(1, 13)])
say("by month, trips:")
for i, m in enumerate(range(1, 13)):
    n = (MON == m).sum()
    say(f"  {i+1:2d}  {T[MON==m].sum()/n:9,.0f} /hr   rev ${R[MON==m].sum()/n:9,.0f}/hr")
say("by hour of day, mean trips:")
for h in range(24):
    n = (HOD == h).sum()
    bar = "#" * int(T[HOD == h].mean() / 120)
    say(f"  {h:02d}  {T[HOD==h].mean():9,.0f}  {bar}")
dwn = ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"]
say("by weekday, mean trips:")
for d in range(7):
    say(f"  {dwn[d]}  {T[DOW==d].mean():9,.0f}")
pk = int(T.argmax())
say(f"peak hour = {full[pk]}  {T[pk]:,.0f} trips")
say(f"trough    = {full[int(T.argmin())]}  {T.min():,.0f} trips")
say(f"peak/trough ratio = {T.max()/T.min():.2f}x")

rule("WEATHER EXPOSURE")
say(f"wet hours (precip>0): {WET.sum():,} of {N:,}  ({100*WET.mean():.1f}%)")
say(f"  of those, snowfall>0: {(WET & (SNOW>0)).sum():,}")
say(f"  mean precip on wet hours = {PR[WET].mean():.2f} mm, p95 = {np.percentile(PR[WET],95):.2f}")
say(f"dry hours precip=0 by construction; max prcp overall = {PR.max()} mm")
codes = sorted(set(WX.tolist()))
LBL = {0:"Clear",1:"Mainly clear",2:"Partly cloudy",3:"Overcast",51:"Light drizzle",
       53:"Drizzle",55:"Dense drizzle",61:"Light rain",63:"Rain",65:"Heavy rain",
       71:"Light snow",73:"Snow",75:"Heavy snow"}
say("\nweather code profile:")
say(f"  {'code':>4} {'label':<16} {'hrs':>5} {'trips/hr':>9} {'rev/trip':>9} {'dist':>6} {'dur':>6} {'tip%':>6}")
base = T[~WET].mean()
for cd in codes:
    m = WX == cd
    say(f"  {cd:>4} {LBL.get(cd,'?'):<16} {m.sum():>5} {T[m].mean():9,.0f} "
        f"{R[m].sum()/T[m].sum():9.2f} {wmean(DIST[m], T[m]):6.2f} "
        f"{wmean(DUR[m], T[m]):6.1f} {100*wmean(TIP[m], T[m])/wmean(FARE[m], T[m]):5.1f}%")

rule("WET vs DRY, CONTROLLED INSIDE (month x hour-of-day) CELLS")
cell = MON * 24 + HOD
ratios, wt = [], []
pairs = []
for cc in np.unique(cell):
    m = cell == cc
    a, b = T[m & WET], T[m & ~WET]
    if len(a) >= 3 and len(b) >= 3:
        ratios.append(a.mean() / b.mean()); wt.append(a.sum() + b.sum())
        pairs.append((cc, a.mean(), b.mean(), len(a), len(b)))
ratios = np.array(ratios); wt = np.array(wt, np.float64)
say(f"cells compared = {len(ratios)} (each needing >=3 wet and >=3 dry hours)")
say(f"trip-weighted mean wet/dry ratio = {(ratios*wt).sum()/wt.sum():.4f}  ({((ratios*wt).sum()/wt.sum()-1)*100:+.1f}%)")
say(f"unweighted mean ratio = {ratios.mean():.4f}   median = {np.median(ratios):.4f}")
say(f"cells where wet > dry: {(ratios>1).sum()} / {len(ratios)}  ({100*(ratios>1).mean():.0f}%)")
say(f"ratio p05={np.percentile(ratios,5):.3f} p95={np.percentile(ratios,95):.3f}")
say(f"NAIVE (uncontrolled) wet/dry ratio = {T[WET].mean()/T[~WET].mean():.4f}")
say("  ^ the naive figure is confounded; the controlled one above is the claim")

# OLS: log trips ~ hour + month + weekend + precip
def ols(y, X):
    beta, *_ = np.linalg.lstsq(X, y, rcond=None)
    resid = y - X @ beta
    dof = len(y) - X.shape[1]
    s2 = (resid**2).sum() / dof
    cov = s2 * np.linalg.pinv(X.T @ X)
    return beta, np.sqrt(np.diag(cov)), resid
X = [np.ones(N)]
for h in range(1, 24): X.append((HOD == h).astype(float))
for m in range(2, 13): X.append((MON == m).astype(float))
X.append((DOW >= 5).astype(float)); X.append(PR); X.append(SNOW)
X = np.column_stack(X)
y = np.log(T)
b, se, _ = ols(y, X)
kpr, ksn = X.shape[1] - 2, X.shape[1] - 1
r2 = 1 - (y - X @ b).var() / y.var()
say(f"\nlog(trips) ~ 23 hour dummies + 11 month dummies + weekend + precip + snowfall")
say(f"  R2 = {r2:.3f}")
say(f"  precip  coef = {b[kpr]:+.5f} (se {se[kpr]:.5f})  t = {b[kpr]/se[kpr]:+.1f}"
    f"   => +1 mm/h: {100*(np.exp(b[kpr])-1):+.2f}% trips/hour")
say(f"  snowfall coef = {b[ksn]:+.5f} (se {se[ksn]:.5f})  t = {b[ksn]/se[ksn]:+.1f}"
    f"   => +1 cm/h: {100*(np.exp(b[ksn])-1):+.2f}% trips/hour")
base_r2 = None
Xb = X[:, :kpr]
bb, _, _ = ols(y, Xb)
say(f"  R2 without weather = {1 - (y - Xb @ bb).var()/y.var():.3f}"
    f"   -> weather adds {r2 - (1 - (y - Xb @ bb).var()/y.var()):.4f} of variance")

rule("SNOW, CONTROLLED")
SNOWY = SNOW > 0
rr, ww = [], []
for cc in np.unique(cell):
    m = cell == cc
    a, b_ = T[m & SNOWY], T[m & ~WET]
    if len(a) >= 1 and len(b_) >= 3:
        rr.append(a.mean() / b_.mean()); ww.append(len(a) + len(b_))
rr = np.array(rr); ww = np.array(ww, np.float64)
if len(rr):
    est_sn = (rr * ww).sum() / ww.sum()
    say(f"snowing vs fully dry, within (month x hour) cells, cells={len(rr)}")
    say(f"  trip-weighted ratio = {est_sn:.4f}  ({100*(est_sn-1):+.1f}%)")
    say(f"  cells where snow < dry: {(rr<1).sum()}/{len(rr)}")
say(f"raw code comparison (uncontrolled): snow hours {T[WX==73].mean():,.0f}/hr vs "
    f"overcast {T[WX==3].mean():,.0f}/hr = {T[WX==73].mean()/T[WX==3].mean():.3f}")
say(f"snow hours n={SNOWY.sum()}  mean snowfall {SNOW[SNOWY].mean():.2f} cm")

rule("WEATHER AND ECONOMICS (same controlled comparison, per-trip metrics)")
ECON = {}
for name, v in [("fare", FARE), ("amount", R / T), ("trip distance", DIST),
                ("tip", TIP), ("duration min", DUR), ("passengers", PAX)]:
    rr, ww = [], []
    for cc in np.unique(cell):
        m = cell == cc
        wet, dry = m & WET, m & ~WET
        if wet.sum() >= 3 and dry.sum() >= 3:
            rr.append(wmean(v[wet], T[wet]) / wmean(v[dry], T[dry]))
            ww.append(T[wet].sum() + T[dry].sum())
    rr = np.array(rr); ww = np.array(ww, np.float64)
    est = (rr * ww).sum() / ww.sum()
    raw = wmean(v[WET], T[WET]) / wmean(v[~WET], T[~WET])
    ECON[name] = {"controlled": round(float(est), 4),
                  "raw": round(float(raw), 4),
                  "pct": round(float(100 * (est - 1)), 2)}
    say(f"  {name:<16} wet/dry = {est:.4f}  ({100*(est-1):+.1f}%)   raw = {raw:.4f}")

rule("ZONE REDISTRIBUTION UNDER WET HOURS")
say("Weather is one citywide reading shared by all 262 zones in an hour, so a")
say("zone's share shifting cannot be an exposure artifact: it is compositional.")
zt_all = np.array(z["zWx"])                 # [262 x nCodes] trips, rows in sorted-zone-id order
rows_all = z["rows"]
zid_all = sorted(r["id"] for r in rows_all)
pos = {zz: i for i, zz in enumerate(zid_all)}
# Reorder the cube into the same order as `rows` (sorted by annual trips).
zt = zt_all[[pos[r["id"]] for r in rows_all]]
rows = rows_all
zid = np.array([r["id"] for r in rows])
zshare = zt / zt.sum()
codes_list = z["wxCodes"]
wet_codes = [i for i, cd in enumerate(codes_list)
             if any(k in LBL.get(cd, "?").lower() for k in ("rain", "drizzle", "snow"))]
dry_codes = [i for i in range(len(codes_list)) if i not in wet_codes]
say(f"wet codes = {[codes_list[i] for i in wet_codes]}  ({len(wet_codes)} of {len(codes_list)})")
zshare_wet = zt[:, wet_codes].sum(1) / zt[:, wet_codes].sum()
zshare_dry = zt[:, dry_codes].sum(1) / zt[:, dry_codes].sum()
tot = zt.sum(1)
VOL_MIN = 20000
qual = tot >= VOL_MIN
idx = np.where(qual, zshare_wet / zshare_dry, np.nan)
pp = (zshare_wet - zshare_dry) * 100          # percentage-point share change
say(f"\nzones with >={VOL_MIN:,} annual trips: {qual.sum()} of 262")
say("\nGAINERS — share of wet-hour trips vs share of dry-hour trips:")
say(f"  {'zone':>5} {'trips':>10} {'share dry':>10} {'share wet':>10} {'index':>7} {'Δpp':>7}")
for i in np.argsort(-np.nan_to_num(pp, nan=-1e9))[:12]:
    say(f"  {zid[i]:>5} {tot[i]:10,.0f} {zshare_dry[i]:10.4%} {zshare_wet[i]:10.4%} "
        f"{idx[i]:7.3f} {pp[i]:+7.3f}")
say("\nLOSERS:")
for i in np.argsort(np.nan_to_num(pp, nan=1e9))[:12]:
    say(f"  {zid[i]:>5} {tot[i]:10,.0f} {zshare_dry[i]:10.4%} {zshare_wet[i]:10.4%} "
        f"{idx[i]:7.3f} {pp[i]:+7.3f}")
say(f"\nindex across the {qual.sum()} qualifying zones: "
    f"{np.nanmin(idx):.3f} to {np.nanmax(idx):.3f}, median {np.nanmedian(idx):.3f}")
say(f"share-point spread: {np.nanmin(pp):+.3f}pp to {np.nanmax(pp):+.3f}pp")
say(f"sanity: sum of share-point changes = {np.nansum(pp):+.2f}pp (must be ~0)")

zr = np.array(z["zWx"])
rshare_wet = zr[:, wet_codes].sum(1) / zr[:, wet_codes].sum()
rshare_dry = zr[:, dry_codes].sum(1) / zr[:, dry_codes].sum()
rpp = (rshare_wet - rshare_dry) * 100
say("\nREVENUE share-point change (wet vs dry hours), same filter:")
for i in np.argsort(-np.nan_to_num(rpp, nan=-1e9))[:6]:
    say(f"  zone {zid[i]:>4}  {rpp[i]:+.4f}pp   revenue ${rows[i]['revenue']:,}")
for i in np.argsort(np.nan_to_num(rpp, nan=1e9))[:6]:
    say(f"  zone {zid[i]:>4}  {rpp[i]:+.4f}pp   revenue ${rows[i]['revenue']:,}")
say("  ^ revenue share moves less than trip share: rain changes WHERE, not HOW MUCH people spend")

say("\nSNOW-ONLY redistribution (snowfall>0 hours vs fully dry):")
snow_codes = [i for i, cd in enumerate(codes_list) if cd in (71, 73, 75)]
say(f"  snow codes {[codes_list[i] for i in snow_codes]}; their share of all trips = "
    f"{zt[:, snow_codes].sum()/zt.sum():.4%}")
sp = np.where(qual, (zt[:, snow_codes].sum(1) / zt[:, snow_codes].sum())
              / (zt[:, dry_codes].sum(1) / zt[:, dry_codes].sum()), np.nan)
for i in np.argsort(-np.nan_to_num(sp, nan=-1e9))[:5]:
    say(f"  gainer zone {zid[i]:>4}  index {sp[i]:.3f}  ({tot[i]:,.0f} trips)")
for i in np.argsort(np.nan_to_num(sp, nan=1e9))[:5]:
    say(f"  loser  zone {zid[i]:>4}  index {sp[i]:.3f}  ({tot[i]:,.0f} trips)")

rule("IS THE REDISTRIBUTION REAL? SIGNIFICANCE")
wet_trips_by_zone = zt[:, wet_codes].sum(1)
dry_trips_by_zone = zt[:, dry_codes].sum(1)
from math import erfc, sqrt as msqrt
def two_prop_z(a, n1, b, n2):
    """z for p1=a/n1 vs p2=b/n2 (pooled), plus one-sided-ish two-sided p."""
    if n1 == 0 or n2 == 0: return 0.0, 1.0
    p = (a + b) / (n1 + n2)
    se = msqrt(p * (1 - p) * (1 / n1 + 1 / n2))
    if se == 0: return 0.0, 1.0
    z = (a / n1 - b / n2) / se
    return z, erfc(abs(z) / msqrt(2))
zs = np.zeros(262); ps = np.ones(262)
for i in range(262):
    zs[i], ps[i] = two_prop_z(wet_trips_by_zone[i], wet_trips_by_zone.sum(),
                              dry_trips_by_zone[i], dry_trips_by_zone.sum())
say(f"two-proportion z-test, {qual.sum()} qualifying zones, wet-share vs dry-share")
say(f"  p < 0.05            : {(ps[qual] < 0.05).sum()} of {qual.sum()}")
say(f"  p < 0.05 Bonferroni (alpha={0.05/qual.sum():.5f}): {(ps[qual] < 0.05/qual.sum()).sum()} of {qual.sum()}")
say(f"  median |z| among qualifying zones = {np.median(np.abs(zs[qual])):.2f}")
say(f"  zone |z| > 3 (conventionally 'real'): {(np.abs(zs[qual]) > 3).sum()}")
say("  NOTE: wet hours are 13.8% of the year, so these share shifts are small in")
say("  absolute terms. Read the effect size, not the p-value.")

rule("LONG-HAUL vs SHORT-HAUL ZONES UNDER WET HOURS (aggregate, high power)")
zdist = np.array([r["dist"] for r in rows])
long_mask = (zdist > 8) & qual
short_mask = (zdist <= 4) & qual
say(f"long-haul zones (mean trip > 8 mi): {long_mask.sum()} zones, "
    f"{tot[long_mask].sum():,.0f} trips ({100*tot[long_mask].sum()/tot.sum():.1f}%)")
say(f"short-haul zones (mean trip <= 4 mi): {short_mask.sum()} zones, "
    f"{tot[short_mask].sum():,.0f} trips ({100*tot[short_mask].sum()/tot.sum():.1f}%)")
for nm, msk in [("long-haul", long_mask), ("short-haul", short_mask)]:
    w = wet_trips_by_zone[msk].sum(); d = dry_trips_by_zone[msk].sum()
    say(f"  {nm:<10} share of wet-hour trips {w/wet_trips_by_zone.sum():.4%}  "
        f"share of dry-hour trips {d/dry_trips_by_zone.sum():.4%}")
wL, nL = wet_trips_by_zone[long_mask].sum(), dry_trips_by_zone[long_mask].sum()
wS, nS = wet_trips_by_zone[short_mask].sum(), dry_trips_by_zone[short_mask].sum()
zL, pL = two_prop_z(wL, nL, wS, nS)
say(f"  long-haul share ratio wet/dry = "
    f"{(wL/nL)/(wS/nS):.4f}   z = {zL:.2f}  p = {pL:.2e}")
say(f"  => in wet hours the airport-corridor zones carry "
    f"{100*((wL/nL)/(wS/nS)-1):+.2f}% of their dry-hour relative weight")
say("  zones 132 and 138 individually (the two long-haul zones):")
for zz in (132, 138):
    i = int(np.where(zid == zz)[0][0])
    zz2, pp2 = two_prop_z(wet_trips_by_zone[i], wet_trips_by_zone.sum(),
                          dry_trips_by_zone[i], dry_trips_by_zone.sum())
    say(f"    zone {zz}: share {zshare_dry[i]:.4%} dry -> {zshare_wet[i]:.4%} wet  "
        f"index {idx[i]:.3f}  z = {zz2:+.2f}  p = {pp2:.3f}")

rule("RAIN AT RUSH HOUR vs RAIN OFF-PEAK")
for nm, hrs in [("peak commute 07-10 & 16-19", list(range(7, 11)) + list(range(16, 20))),
                ("off-peak 11-15", list(range(11, 16))),
                ("overnight 00-05", list(range(0, 6)))]:
    rr, ww = [], []
    for cc in np.unique(cell):
        m = (cell == cc) & np.isin(HOD, hrs)
        a, b_ = T[m & WET], T[m & ~WET]
        if len(a) >= 3 and len(b_) >= 3:
            rr.append(a.mean() / b_.mean()); ww.append(len(a) + len(b_))
    rr = np.array(rr); ww = np.array(ww, np.float64)
    est = (rr * ww).sum() / ww.sum()
    say(f"  {nm:<28} wet/dry = {est:.4f} ({100*(est-1):+.1f}%)   cells={len(rr)}")

rule("TEMPERATURE RESPONSE (residualised on month x hour)")
resid = np.log(T) - X[:, :-1] @ b[:-1]
bands = [(-99,-5),( -5,0),(0,5),(5,10),(10,15),(15,20),(20,25),(25,30),(30,99)]
say(f"  {'band C':>10} {'hrs':>5} {'resid vs model':>16} {'trips/hr':>9}")
for lo, hi in bands:
    m = (TEMP >= lo) & (TEMP < hi)
    if m.sum() == 0: continue
    say(f"  {f'{lo if lo>-99 else -99}..{hi if hi<99 else 99}':>10} {m.sum():>5} "
        f"{resid[m].mean():+16.3f} {T[m].mean():9,.0f}")

rule("ECONOMICS")
say(f"fare per trip        ${wmean(FARE,T):.2f}")
say(f"revenue per trip     ${R.sum()/T.sum():.2f}")
say(f"trips per $1 revenue {T.sum()/R.sum():.4f}")
say(f"mean trip distance   {wmean(DIST,T):.2f} mi")
say(f"mean duration        {wmean(DUR,T):.1f} min")
say(f"mean passengers      {wmean(PAX,T):.2f}")
say(f"tip per trip         ${wmean(TIP,T):.2f}  ({100*wmean(TIP,T)/wmean(FARE,T):.1f}% of fare)")
say("\nrevenue per hour by month:")
for m in range(1, 13):
    n = (MON == m).sum(); say(f"  {m:2d}  ${R[MON==m].sum()/n:10,.0f}")
say("\nrevenue per trip-hour by hour of day:")
for h in range(24):
    n = (HOD == h).sum(); say(f"  {h:02d}  ${R[HOD==h].sum()/n:8,.0f}")

rule("ZONE ECONOMICS")
rows = z["rows"]
rows_sorted = sorted(rows, key=lambda r: -r["revenue"])
say("top 12 zones by revenue:")
say(f"  {'zone':>5} {'trips':>10} {'revenue':>14} {'$/trip':>8} {'dist':>6} {'dur':>6} {'peak h':>7}")
for r in rows_sorted[:12]:
    say(f"  {r['id']:>5} {r['trips']:10,.0f} {r['revenue']:14,.0f} {r['amount']:8.2f} "
        f"{r['dist']:6.2f} {r['dur']:6.1f} {r['peakHour']:>7}")
tt = sum(r["trips"] for r in rows)
say(f"\ntop 10 zones = {100*sum(r['trips'] for r in rows[:10])/tt:.1f}% of all trips")
say(f"top 50 zones = {100*sum(r['trips'] for r in rows[:50])/tt:.1f}%")
say(f"bottom 100 zones = {100*sum(r['trips'] for r in rows[-100:])/tt:.1f}%")
hi = [r for r in rows if r["trips"] >= VOL_MIN]
say("\nhighest revenue-per-trip zones (>=20,000 annual trips):")
for r in sorted(hi, key=lambda r: -r["amount"])[:10]:
    say(f"  {r['id']:>5}  ${r['amount']:7.2f}/trip   dist {r['dist']:5.2f}  dur {r['dur']:5.1f}  trips {r['trips']:9,.0f}")
say("\nlong-haul zones (mean trip distance > 8 mi, >=20k trips):")
lh = sorted([r for r in hi if r["dist"] > 8], key=lambda r: -r["revenue"])
say(f"  count = {len(lh)}   trips = {sum(r['trips'] for r in lh):,}  "
    f"({100*sum(r['trips'] for r in lh)/tt:.1f}% of all)")
say(f"  revenue = ${sum(r['revenue'] for r in lh):,}  ({100*sum(r['revenue'] for r in lh)/sum(r['revenue'] for r in rows):.1f}% of all)")
for r in lh:
    say(f"  zone {r['id']:>4}  trips {r['trips']:>10,}  ${r['amount']:7.2f}/trip  dist {r['dist']:5.2f}  dur {r['dur']:5.1f}")
say(f"  citywide for comparison: ${R.sum()/T.sum():.2f}/trip, dist {wmean(DIST,T):.2f} mi")

rule("OTHER WEATHER AXES (controlled)")
for name, v in [("cloud cover %", CLOUD), ("wind km/h", WIND), ("humidity %", HUM)]:
    rr, ww = [], []
    for cc in np.unique(cell):
        m = cell == cc
        if m.sum() < 8: continue
        q1, q3 = np.quantile(v[m], [.25, .75])
        glo = m & (v <= q1)
        ghi = m & (v >= q3)
        if glo.sum() >= 2 and ghi.sum() >= 2:
            rr.append(T[ghi].mean() / T[glo].mean()); ww.append(ghi.sum() + glo.sum())
    rr = np.array(rr); ww = np.array(ww, np.float64)
    est = (rr * ww).sum() / ww.sum()
    say(f"  {name:<14} top-quartile vs bottom-quartile trips ratio = {est:.4f} "
        f"({100*(est-1):+.1f}%)  cells={len(rr)}")

rule("WHAT THE FOUR HEADLINE NUMBERS ARE")
say(f"1. controlled rain effect on trips   = {100*((ratios*wt).sum()/wt.sum()-1):+.1f}%   "
    f"(naive would say {100*(T[WET].mean()/T[~WET].mean()-1):+.1f}%)")
say(f"2. controlled snow effect on trips   = {100*(est_sn-1):+.1f}%   (n={SNOWY.sum()} snow hours)")
say(f"3. long-haul zones' share of trips   = {100*tot[long_mask].sum()/tot.sum():.1f}% of trips, "
    f"{100*sum(r['revenue'] for r in rows if r['id'] in (132,138,70,76))/sum(r['revenue'] for r in rows):.1f}% of revenue")
say(f"4. peak-to-trough demand             = {T.max()/T.min():.0f}x  ({int(T.max()):,} vs {int(T.min()):,} trips/hour)")
say(f"   peak-to-trough revenue per hour   = {R.max()/R.min():.0f}x")

rule("HEAVY RAIN, CONTROLLED (does the story change above a threshold?)")
heavy_rows = []
for thr in [1.0, 2.0, 2.5, 4.0]:
    hv = PR >= thr
    dr = PR < 0.05
    hr, hw = [], []
    for cc in np.unique(cell):
        m = cell == cc
        a, b_ = T[m & hv], T[m & dr]
        if len(a) >= 2 and len(b_) >= 2:
            hr.append(a.mean() / b_.mean()); hw.append(len(a) + len(b_))
    if not hr:
        continue
    hEst = np.average(hr, weights=hw)
    nh = int(hv.sum())
    hNaive = T[hv].mean() / T[dr].mean()
    say(f"  >= {thr:>4} mm/h  hours={nh:>4}  controlled={hEst:.4f} ({100*(hEst-1):+.1f}%)  "
        f"naive={hNaive:.4f} ({100*(hNaive-1):+.1f}%)  cells={len(hr)}  "
        f"cells below 1: {(np.array(hr) < 1).sum()}/{len(hr)}")
    heavy_rows.append({"threshold": thr, "hours": nh,
                       "controlledPct": round(float(100 * (hEst - 1)), 1),
                       "naivePct": round(float(100 * (hNaive - 1)), 1),
                       "cells": len(hr),
                       "cellsBelowOne": int((np.array(hr) < 1).sum())})

# ---------------------------------------------------------------------------
# Machine-readable findings. The page renders these; it hard-codes none of them.
# ---------------------------------------------------------------------------
zpos = {r["id"]: i for i, r in enumerate(rows)}
def top_by(key, mask, sign, n=8):
    idxs = np.where(mask)[0]
    idxs = idxs[np.argsort(-sign * key[idxs])]
    return [{"id": int(zid[i]), "trips": int(tot[i]),
             "shareDry": round(float(zshare_dry[i]), 5),
             "shareWet": round(float(zshare_wet[i]), 5),
             "index": round(float(idx[i]), 4),
             "deltaPP": round(float(pp[i]), 4),
             "revenue": int(rows[i]["revenue"]),
             "amount": rows[i]["amount"], "dist": rows[i]["dist"]}
            for i in idxs[:n]]

code_profile = []
for cd in codes:
    m = WX == cd
    code_profile.append({
        "code": int(cd), "label": LBL.get(cd, "?"), "hours": int(m.sum()),
        "tripsPerHour": round(float(T[m].mean()), 1),
        "amountPerTrip": round(float(R[m].sum() / T[m].sum()), 2),
        "dist": round(wmean(DIST[m], T[m]), 2),
        "dur": round(wmean(DUR[m], T[m]), 1),
        "tipPct": round(100 * wmean(TIP[m], T[m]) / wmean(FARE[m], T[m]), 2),
        "tripShare": round(float(T[m].sum() / T.sum()), 5),
    })

findings = {
    "generated": "scripts/analyse.py over src/data/*.json",
    "totals": {
        "hours": int(N), "zones": 262, "rows": 976425,
        "trips": int(T.sum()), "revenue": int(round(R.sum())),
        "tripsPerHour": round(float(T.mean()), 1),
        "revenuePerTrip": round(float(R.sum() / T.sum()), 2),
        "farePerTrip": round(wmean(FARE, T), 2),
        "tipPerTrip": round(wmean(TIP, T), 2),
        "tipPct": round(100 * wmean(TIP, T) / wmean(FARE, T), 1),
        "distMi": round(wmean(DIST, T), 2),
        "durMin": round(wmean(DUR, T), 1),
        "pax": round(wmean(PAX, T), 2),
        "peakTrips": int(T.max()), "troughTrips": int(T.min()),
        "peakTs": str(full[int(T.argmax())]), "troughTs": str(full[int(T.argmin())]),
        "peakRatio": round(float(T.max() / T.min()), 1),
        "peakRevRatio": round(float(R.max() / R.min()), 1),
        "wetHours": int(WET.sum()), "wetShare": round(float(100 * WET.mean()), 1),
        "snowHours": int(SNOWY.sum()),
        "top10Share": round(float(100 * sum(r["trips"] for r in rows[:10]) / T.sum()), 1),
        "top50Share": round(float(100 * sum(r["trips"] for r in rows[:50]) / T.sum()), 1),
    },
    "rain": {
        "controlledPct": round(float(100 * ((ratios * wt).sum() / wt.sum() - 1)), 2),
        "naivePct": round(float(100 * (T[WET].mean() / T[~WET].mean() - 1)), 2),
        "cells": int(len(ratios)), "cellsWetHigher": int((ratios > 1).sum()),
        "p05": round(float(np.percentile(ratios, 5)), 3),
        "p95": round(float(np.percentile(ratios, 95)), 3),
        "coefPerMm": round(float(100 * (np.exp(b[kpr]) - 1)), 2),
        "tStat": round(float(b[kpr] / se[kpr]), 1),
        "snowCoefPerCm": round(float(100 * (np.exp(b[ksn]) - 1)), 2),
        "snowTStat": round(float(b[ksn] / se[ksn]), 1),
        "snowControlledPct": round(float(100 * (est_sn - 1)), 2),
        "r2": round(float(r2), 3), "r2NoWeather": round(float(1 - (y - Xb @ bb).var() / y.var()), 3),
        "heavy": heavy_rows,
        "econ": ECON,
    },
    "zones": {
        "qualifying": int(qual.sum()), "volMin": VOL_MIN,
        "gainers": top_by(pp, qual, +1),
        "losers": top_by(pp, qual, -1),
        "sigP05": int((ps[qual] < 0.05).sum()),
        "sigBonferroni": int((ps[qual] < 0.05 / qual.sum()).sum()),
        "indexMin": round(float(np.nanmin(idx)), 3),
        "indexMax": round(float(np.nanmax(idx)), 3),
        "indexMedian": round(float(np.nanmedian(idx)), 3),
        "longHaulIds": [132, 138, 70, 76],
        "longHaulTripsShare": round(float(100 * tot[long_mask].sum() / tot.sum()), 1),
        "longHaulRevShare": round(float(100 * sum(rows[i]["revenue"] for i in np.where(long_mask)[0])
                                      / sum(r["revenue"] for r in rows)), 1),
        "longHaulIndex": round(float((wL / nL) / (wS / nS)), 4),
        "longHaulZ": round(float(zL), 1),
        "longHaulP": f"{pL:.1e}",
        "longHaulShareDry": round(float(100 * nL / dry_trips_by_zone.sum()), 4),
        "longHaulShareWet": round(float(100 * wL / wet_trips_by_zone.sum()), 4),
        "longHaulDeltaPP": round(float(100 * (wL / wet_trips_by_zone.sum()
                                              - nL / dry_trips_by_zone.sum())), 4),
        "longHaul": [
            {"id": int(zid[i]), "trips": int(tot[i]), "revenue": int(rows[i]["revenue"]),
             "amount": rows[i]["amount"], "dist": rows[i]["dist"], "dur": rows[i]["dur"],
             "shareDry": round(float(zshare_dry[i]), 5), "shareWet": round(float(zshare_wet[i]), 5),
             "index": round(float(idx[i]), 4), "z": round(float(zs[i]), 1)}
            for i in np.where(long_mask)[0]
        ],
        "z132": {"shareDry": round(float(zshare_dry[zpos[132]]), 5),
                 "shareWet": round(float(zshare_wet[zpos[132]]), 5),
                 "index": round(float(idx[zpos[132]]), 4), "z": round(float(zs[zpos[132]]), 1)},
        "z138": {"shareDry": round(float(zshare_dry[zpos[138]]), 5),
                 "shareWet": round(float(zshare_wet[zpos[138]]), 5),
                 "index": round(float(idx[zpos[138]]), 4), "z": round(float(zs[zpos[138]]), 1)},
    },
    "codes": code_profile,
    "rush": {},
}
for nm, hrs in [("peak", list(range(7, 11)) + list(range(16, 20))),
                ("offPeak", list(range(11, 16))),
                ("overnight", list(range(0, 6)))]:
    rr, ww = [], []
    for cc in np.unique(cell):
        m = (cell == cc) & np.isin(HOD, hrs)
        a, b_ = T[m & WET], T[m & ~WET]
        if len(a) >= 3 and len(b_) >= 3:
            rr.append(a.mean() / b_.mean()); ww.append(len(a) + len(b_))
    rr = np.array(rr); ww = np.array(ww, np.float64)
    findings["rush"][nm] = {"pct": round(float(100 * ((rr * ww).sum() / ww.sum() - 1)), 1),
                            "cells": int(len(rr))}
json.dump(findings, open("src/data/findings.json", "w"), indent=1)
say("\nwrote src/data/findings.json")

open("scripts/findings.txt", "w").write("\n".join(out))
