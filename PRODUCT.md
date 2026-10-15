# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

- **Astro in SSR mode** (`@astrojs/node`, standalone) so API routes can query the database at request time.
- **MongoDB** at `mongodb://127.0.0.1:27017`, database `nyc_taxi`. The user already runs mongod locally, so this needed no new infrastructure.
- Charts are **hand-drawn SVG with no chart library**, so the visual system is fully controlled.
- The map is an inline SVG choropleth built from the official TLC zone GeoJSON, so it works offline with no tile service.
- Loader: `scripts/load_mongo.py` (Python + pymongo, run from `.venv`).`

## Users

A student submitting this as an MCA / Big Data Analytics coursework project, and the evaluator (faculty or peer) who grades it. The evaluator's job is to verify that the taxi dataset and the weather dataset were joined correctly, that the aggregation is sound, and that the conclusions are defensible — and to be impressed. The student's job is to *understand* the data well enough to defend it in a viva.

This is a read-and-verify surface, not a marketing surface. Every headline number must be traceable to a stated aggregation over the source CSV.

## Product Purpose

An interactive analytical dashboard over `nyc_taxi_weather_hourly.csv` — 976,425 rows of NYC yellow-taxi demand already aggregated to (hour × pickup zone) and joined to hourly Open-Meteo weather, covering all of calendar year 2025.

It exists to answer four questions, and to make the *methodology* behind each answer inspectable:

1. How does weather change how many trips New Yorkers take?
2. When and where does demand peak?
3. What are the economics of a trip, and who captures them?
4. Does weather change not just volume but *where people go* and *what they pay*?

Success means an evaluator can open it, understand the year's shape in under a minute, find at least one finding they did not expect, and confirm the numbers are not decorative.

## Positioning

Most taxi dashboards show trip volume over time. This one treats weather as the independent variable and demand, geography, and revenue as dependent variables — and it answers the interaction question (not just volume, but *composition*) that a volume-only dashboard cannot. It ships its own methodology and fidelity notes instead of asking the reader to trust the visuals.

## Operating Context

Single-page analytical surface, opened in a desktop browser, presented or screenshotted for a submission. Data is frozen at build time from the source CSV; there is no backend and no live feed. The reader may explore filters, drill into individual taxi zones, and check the aggregation notes.

## Capabilities and Constraints

- Seven surfaces: Overview, Cab, Weather, Cab × Weather, Zones & map, Origin & destination, Method.

- All 26 source columns are numeric and fully populated; there are zero blank cells, so no imputation is performed or needed.
- 8,759 distinct hourly timestamps for 2025 (8,760 minus the DST spring-forward hour on 2025-03-09).
- 262 distinct `PULocationID` values. The source extract contains **no** TLC zone-name or borough lookup — only numeric IDs, so names and boroughs are joined from the official NYC TLC zone file (NYC Open Data dataset `8meu-9t5y`), which is cited wherever they appear. That file ships 263 features but only 260 unique location IDs (56 and 103 repeat); 258 of the 262 zones in the extract resolve, and 264/265 stay unmapped and grey.
- The extract carries **`dropoff_count`** as well as `trip_count`: two marginals of the same trip set, per (hour, zone). This supports origin density, destination density and net flow, and does **not** support a pairwise origin–destination matrix, which would need a dropoff-zone column per trip. The dashboard states this limit in the interface rather than implying flows it cannot compute.
- `total_revenue` reconciles exactly with `trip_count × avg_total_amount` (ratio 1.0000), and `avg_total_amount` already includes tip, tolls and surcharges — so `fare + tip` does not sum to it.
- Weather is citywide (one Open-Meteo grid reading per hour) and is therefore repeated across all 262 zone rows for a given hour. Zone-level weather analysis inherits that limitation and must say so.
- `PULocationID` is a pickup zone. There is no dropoff-zone column, so no origin-destination or flow analysis is possible.
- Distributional averages in the source are per-(hour, zone) means. Any citywide or multi-zone average computed from them must be re-weighted by `trip_count` rather than averaged naively. The build does this.
- The dashboard is interactive by the user's explicit choice: month / day-of-week / hour-of-day / weather-condition / temperature filters plus per-zone drilldown.

## Brand Commitments

- **Light theme is pinned.** The user stated "use good design light mode theme" as a binding constraint. No dark-mode toggle, and the visual world must be authored for a light ground from the start rather than inverted later.
- Name, voice, and identity beyond that are not established. The dashboard may be titled descriptively.

## Evidence on Hand

- `nyc_taxi_weather_hourly.csv` — 118 MB, 976,425 rows, 26 columns, full year 2025. Sole data source.
- Verified from the file: 34,938,284 total trips, \$1,030,220,290 total revenue, mean 3,989 trips per hour citywide.
- No TLC zone-name lookup file, no shapefile, no zone photo, no external benchmark. Nothing in the interface may imply these exist.
- Weather codes present: 0, 1, 2, 3 (clear→overcast) and 51, 53, 55, 61, 63, 65, 71, 73, 75 (drizzle→snow). No thunderstorm or fog codes in this extract.

## Product Principles

1. **Every number is reproducible.** Each headline figure exposes the aggregation that produced it. No decorative statistics.
2. **Weather is the lens, not the decoration.** The dataset's whole reason to exist is the taxi × weather join; the interface should make that join the protagonist.
3. **Composition over count.** "Where do people go when it rains" is a better question than "how many trips on rainy days," and the product should prove it with a zone-level comparison.
4. **State the limits in the open.** Unweighted averages, repeated citywide weather, missing zone names, and DST are disclosed on the page rather than buried.
5. **Interactive but instant.** Filtering is client-side over a pre-aggregated cube; no filter may block on a network round-trip.

## Accessibility & Inclusion

Target is WCAG 2.2 AA. Charts must be legible without colour alone (secondary encoding via labels, shape, or position), all interactive controls keyboard-reachable with visible focus, and text contrast at or above 4.5:1 in the pinned light theme.
