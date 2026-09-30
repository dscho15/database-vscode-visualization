# SQLite Lens

A SQLite database explorer inside VS Code. Open a `.sqlite3`, `.sqlite`, `.db`, or `.db3` file to browse data, inspect relationships, write SQL, and chart results.

## Install and open

1. In VS Code, run **Extensions: Install from VSIX…** and select `dist/sqlite-lens-0.2.0.vsix`.
2. Run **SQLite Lens: Open Database**, or right-click a database in Explorer and choose that command.
3. Open `/srv/shared/forecasting_california/context.sqlite3` to explore the California dataset. If another extension owns the file association, use **Reopen Editor With… → SQLite Lens**.

For a Remote SSH, WSL, or container workspace, install the extension on that remote host. The Go reader runs beside the database on the extension host; database contents are never uploaded to a service.

**Requirements:** VS Code 1.90+ on Linux, macOS, or Windows (x64 or ARM64). The VSIX bundles a Go executable and SQLite for each of those six targets. Users do not need Go, Python, a SQLite CLI, native Node modules, or a separate server. Developers can optionally select a custom reader with `sqliteLens.backendPath`.

Version 0.2 replaces the Python reader completely. The old `sqliteLens.pythonPath` setting is no longer used and can be removed from your settings.

## Features

- **Data:** searchable table list, paged rows, column sorting, and a parameterized, case-sensitive “contains” filter. Select a cell to inspect text or pretty-print JSON; millisecond timestamp columns also show UTC dates.
- **SQL editor:** execute a single read-only statement, including CTEs and joins. Run with Ctrl/Cmd+Enter, cancel a slow query, and inspect its results. SQL text and selected table survive webview recreation.
- **Schema:** inspect columns, composite primary keys, indexes, generated columns, SQL definitions, and clickable declared foreign-key relationships. Relationships are not guessed from column names.
- **Chart:** line, bar, and scatter plots from the displayed rows, with selectable axes. Numeric X values use a numeric scale; text values retain result order. Hover points for values. Use SQL to aggregate and order larger datasets.
- **CSV:** export the current displayed result, with quoted values and protection against spreadsheet formula interpretation.

The interface follows the active VS Code theme and works in narrow editor panes.

## Large databases and read-only behavior

The database is opened with SQLite `OPEN_READONLY`, `query_only`, and an authorizer that rejects writes, attachments, extension loading, and mutating PRAGMAs. It is never imported into memory. Each request has its own short-lived connection, so Refresh reads current committed data without retaining a long-lived transaction. SQLite may use existing WAL shared-memory coordination files when reading a live WAL database.

Browsing requests 100 rows by default (up to 500). BLOB values appear as byte counts computed inside SQLite, without fetching their payloads. Text previews stop at 4,000 characters. Integers beyond JavaScript's safe range are preserved as decimal strings. Queries return at most 1,000 rows and approximately 2 MB of preview data, and SQLite values/rows are limited to 16 MB. Direct SQL selecting BLOBs still materializes those values inside SQLite; prefer `length(blob_column)` for large payloads.

The default timeout is 15 seconds, configurable with `sqliteLens.queryTimeout`. Cancel terminates the reader process. No automatic full-table counts or database integrity scans run on open. Pagination uses `LIMIT/OFFSET`, ordered by primary key where available; deep pages and unindexed sorts/filters can still be expensive. Concurrent database changes can shift page boundaries. Views without explicit ordering follow SQLite's result order.

Charts represent only the currently displayed result, not the whole table. Bar charts show at most 80 points. Missing values are omitted. CSV likewise exports displayed rows, keeping BLOB summaries and truncated text visibly marked. Binary tensor formats such as California's `values_blob` are not decoded automatically.

## California examples

Daily context coverage:

```sql
SELECT day, slot_count, step_ms,
       length(values_blob) AS payload_bytes
FROM context_days
WHERE project_id = 'california'
ORDER BY day
LIMIT 365;
```

Run this query, select **Chart**, and choose `day` for X and `slot_count` for Y.

Forecast volume by origin date:

```sql
SELECT date(origin_timestamp_ms / 1000, 'unixepoch') AS day,
       count(*) AS batches
FROM forecast_batches
WHERE project_id = 'california'
GROUP BY day
ORDER BY day;
```

Metrics:

```sql
SELECT metric_name, metric_value, sample_count, slice_kind, slice_value
FROM metric_results
WHERE slice_kind = 'overall'
ORDER BY metric_name;
```

## Develop and verify

Development requires Go 1.26+ and Node.js 22+. The backend uses [ncruces/go-sqlite3](https://github.com/ncruces/go-sqlite3), a cgo-free SQLite implementation, with the standard compatible VFS and SQLite authorizer. Its dependencies are pinned in `go.mod` and `go.sum`. There is no production npm dependency.

The JavaScript extension launches the Go reader using JSON over stdin/stdout. The webview and its message protocol are unchanged. Backend source lives in `cmd/sqlite-lens` and `internal/database`; the reader accepts one request per process and never exposes a write action.

```sh
npm ci
npm run build
npm run check
npm test
npx playwright install chromium
npm run test:ui
npm run package
```

Press **F5** to build the host binary and launch an Extension Development Host using the included launch configuration. `npm run build` builds the current host target. `npm run package` cross-compiles all six targets with `CGO_ENABLED=0`, collects third-party license notices, and writes the universal VSIX to `dist/`. Linux builds are statically linked and do not require a system SQLite or libc installation.

The Go tests cover read-only enforcement, Unicode and integer preservation, result limits, timeout handling, WAL visibility, schema metadata, and pagination. Node tests exercise the real binary and extension lifecycle; fixtures are also created in Go. The automated browser check uses the shipped HTML/CSS/JavaScript and real Go reader, with a small VS Code message API shim. It covers browsing, pagination, filtering, the cell inspector, relationships, SQL, charts, write denial, cancellation, and narrow layout. It does not replace a full VS Code Extension Host test.

To run it read-only against another database with the California schema:

```sh
SQLITE_LENS_TEST_DB=/srv/shared/forecasting_california/context.sqlite3 npm run test:ui
```

`CHROMIUM_PATH` can point to an existing Chromium executable. Screenshots are written to ignored `artifacts/` files. Linux Chromium may require Playwright's system libraries.

The integration follows the official [VS Code custom editor API](https://code.visualstudio.com/api/extension-guides/custom-editors) and [webview security guidance](https://code.visualstudio.com/api/extension-guides/webview#security).
