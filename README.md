# Plotcraft

**A free, open-source BI studio that runs in your browser.** Drag fields onto shelves like in Tableau, build Power BI-style dashboards with slicers and cross-filtering, write calculated fields, join tables. Your data never leaves your device.

**Live app:** https://plotcraft-alpha.vercel.app

![A Plotcraft dashboard: KPI cards with sparklines, a borough slicer, a line chart, a donut, a bar chart, a heatmap, a matrix and a histogram](docs/dashboard.png)

## What it does

**Build charts (the Tableau part)**
- Drag fields onto **Columns, Rows, Color, Size, Label, Detail and Filters**. Text fields split the view into categories; numbers and dates become axes.
- **Automatic mark** choice, or pick one: bar, line, area, circle (scatter), square (heatmap), text table, tick, **pie, donut, treemap**.
- Aggregations: sum, average, median, min, max, count, count distinct.
- Dates as timelines (year, quarter, month, week, day) or categories (month of year, weekday, hour).
- **Bins and histograms** for any number field, sort by value, small multiples from extra fields on a shelf.
- **Data** and **SQL** tabs for every chart. The SQL tab gives a DuckDB query that returns the same table.

**Dashboards (the Power BI part)**
- A 12-column canvas: drag tiles to move them and pull the corner to resize them.
- Tiles: any sheet, **KPI cards** (value, trend sparkline, change vs the previous period), **slicers**, text.
- **Cross-filtering**: click a bar, slice, cell or point and every other tile filters to it.
- **Matrix with row and column totals**, with conditional colour, plus a **gauge** visual.

**Data model**
- Open CSV, TSV or JSON. Types are detected: currency strings like `"$1,200.50"`, US dates like `1/5/2024`, blanks.
- **Join** extra tables (left or inner) on a shared column, like a Power BI relationship. The editor shows how many rows match.
- Rename, retype, hide, or switch fields between dimension and measure. Every sheet, dashboard and formula updates.
- **Calculated fields** with a Tableau-style formula language:
  - row-level: `IF [trip_distance] >= 10 THEN "Long" ELSE "Short" END`, `DATEDIFF('day', [Order Date], [Ship Date])`
  - aggregate, like a DAX measure: `SUM([tip_amount]) / SUM([fare_amount]) * 100`
  - 45+ functions (logic, math, text, dates). The editor checks types as you type, points to the error, and previews the result.

**Projects**
- Your project (data included) is saved in the browser's IndexedDB and is still there after a reload.
- Save or open a workbook as `.plotcraft.json`, with or without the data. Export charts as PNG/SVG and tables as CSV.
- Light and dark themes. Works on phones; on small screens the dashboard stacks into one column.

![The calculated field editor with a live preview](docs/calculated-field.png)

## Run it locally

It is a static site with no build step:

```bash
git clone https://github.com/jayeed17/plotcraft
cd plotcraft
python3 -m http.server 8000      # or: npx serve .
# open http://localhost:8000
```

## How it works

| File | Job |
|---|---|
| `js/data.js` | Parses files, infers types, applies joins, renames and type changes, materialises row-level calculations |
| `js/formula.js` | Tokenizer, parser, type checker, row and aggregate compilers, DuckDB SQL translator (no `eval`) |
| `js/engine.js` | Filters, groups and aggregates columnar data (typed arrays, dictionary-encoded strings) |
| `js/sql.js` | Writes the equivalent DuckDB SQL: joins, type fixes and calculations in a `WITH` block |
| `js/chart.js` | Compiles shelves into Vega-Lite specs, including the pie, treemap and histogram layouts |
| `js/visuals.js` | Matrix with totals, KPI cards, gauge |
| `js/dashboard.js` | Canvas layout, drag/resize, slicers, cross-filtering |
| `js/sheet.js`, `js/model.js`, `js/calc.js` | Worksheet UI, Data source view, formula editor |

Charts are drawn with [Vega-Lite](https://vega.github.io/vega-lite/) and CSV parsing uses [Papa Parse](https://www.papaparse.com/). Both load from jsDelivr at pinned versions.

## Tests

The engine is checked against **DuckDB**. A test drives every chart type in a headless browser, takes the SQL Plotcraft generates, runs it in DuckDB, and compares every row. That includes joins, calculated fields, bins, cross-filters, US dates and currency text.

```bash
cd tests && npm install
npx playwright install chromium
cd .. && node tests/smoke.js && node tests/interact.js
node tests/parity.js && pip install duckdb && python3 tests/duckdb_parity.py
```

## Roadmap

- Maps (latitude/longitude and region fills)
- An optional DuckDB-WASM engine for files with millions of rows, and Parquet input
- Parameters, table calculations (running total, percent of total), drill-down hierarchies
- Dashboard export to PDF/PNG

## License

MIT © 2026 Zayeed Bin Kabir. The sample taxi trips are synthetic; borough populations are from the 2020 U.S. Census.
