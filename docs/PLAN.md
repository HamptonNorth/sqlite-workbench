# SQLite Workbench — implementation plan

## Context

`sqlite-workbench` is a **new, empty repo** (only `HANDOFF.md`, `.gitignore`, git). The
goal: a standalone, single-purpose web tool that points at any `.sqlite` file and gives a
browser SQL workbench — browse tables, run queries, safely edit with guard rails, save
snippets, export, document schema. It runs *alongside* (not inside) whatever app owns the
DB, so it works next to an app in any language.

A complete, tested reference exists in `/var/home/rcollins/code/aph2-diary` but is wired
into that one app. This project **extracts and generalises** it. The crown jewel is the
safety model: **the read-only SQLite connection is the security boundary**, not string
matching. Getting the safety tests green through the refactor is the definition of done for
the core.

**Decisions locked for this plan:** build the **full tool (all 6 slices)**; snippets live in
a **sidecar SQLite file** (`<db>.workbench.sqlite`, never touching the target schema, opt-in
flag for in-DB); **Bun-only, distributed via bunx** (no Node adapter, no compiled binary yet
— but keep the SQLite layer behind `sqlite.js` so those stay possible later).

Reference is treated as our own prior work to reuse (private project, no third-party code).

## Reference map (what to port, and from where)

| Reference file | Ported into | Notes |
|---|---|---|
| `aph2-diary/server/routes/sql.js` (364 ln) | `src/server/core.js` + `src/server/sqlite.js` | The safety core. Split Hono routing from pure logic. |
| `aph2-diary/tests/tier2/sql.test.js` (199 ln) | `test/safety.test.js` | **Port first, keep green.** Rewrite the auth harness (no `admin_users`). |
| `aph2-diary/server/db.js` | `src/server/sqlite.js` | Pattern for exported resolved path + idempotent side-table creation. |
| `aph2-diary/server/lib/sessionId.js` | `src/server/auth.js` | `hashSessionId` — reused verbatim for sidecar session validation. |
| `aph2-diary/client/src/components/sql-workbench.js` (726 ln) | `src/client/workbench.js` | Lit component. Port to Shadow DOM + self-contained CSS (the big UI job). |
| `aph2-diary/docs/user_guide_sql_workbench.md` | `README.md` | Basis for end-user docs. |

## Architecture & the seams to cut

The reference is coupled to the host app in 4 places; each becomes an injected dependency:

1. **DB path** — reference resolves `../db/aph2.sqlite`. → CLI/config supplies it; `sqlite.js`
   exports the resolved path (same anti-drift reason as `db.js`).
2. **Auth** — reference reads `c.get("admin")` with `sql_read`/`sql_write` flags. → replace
   with injected `canRead(req)` / `canWrite(req)` policy (see Slice 6). Core never assumes an
   `admin_users` table.
3. **Audit** — reference writes the app's `audit_log`. → injected `onExecute({ sql,
   rowsAffected, committed, who, snapshot })` sink; default writes an `audit` table in the
   sidecar SQLite (or a log file).
4. **Snippets store** — reference uses an in-target-DB `sql_snippets` table. → default to a
   **sidecar `<db>.workbench.sqlite`** with its own `snippets` table; `--snippets-in-db` opt-in
   to use the target DB instead.

**Framework-agnostic core.** `core.js` exposes plain handlers operating on `{ sql, commit,
who, canWrite }` and returns plain result objects (the API-contract shapes). A thin
`Bun.serve` wrapper in `bin/cli.js`/`server.js` does routing, JSON, and policy injection. No
Hono dependency — keeps a future Node port cheap.

**Proposed layout** (from handoff):
```
bin/cli.js            # arg parsing -> starts Bun.serve
src/server/
  core.js             # framework-agnostic handlers (safety core, no I/O framework)
  sqlite.js           # bun:sqlite: ro/rw handles, snapshot, WAL check, resolved path
  auth.js             # canRead/canWrite defaults + hashSessionId
  snippets.js         # sidecar-SQLite snippet store (+ optional in-DB)
  server.js           # Bun.serve wrapper: routes -> core handlers, injects policy
src/client/
  workbench.js        # Shadow-DOM web component
  index.html          # minimal shell mounting <sqlite-workbench>
test/
  safety.test.js      # PORTED FIRST
README.md
```

## Build order (each slice independently runnable)

### Slice 1 — CLI + server skeleton (+ WAL/readonly proof)
- `bin/cli.js`: parse `<db>` positional + `--write`, `--port` (9999), `--host` (127.0.0.1),
  `--set-wal`, `--snippets-in-db`, `--base` (default `/api`). Use `util.parseArgs`. Error
  clearly if the DB file is missing/unreadable.
- `src/server/sqlite.js`: open the file; **detect journal mode** (`PRAGMA journal_mode`) —
  if not WAL, **warn loudly** but never silently flip it; `--set-wal` opt-in flips it. Set
  `PRAGMA busy_timeout = 5000`. Lazy `readonlyDb()` opened `{ readonly: true }`. Export the
  resolved `dbPath`.
- `src/server/server.js` + `Bun.serve`: bind localhost by default; serve a page that says
  "connected: N tables". `--host 0.0.0.0` is explicit opt-in.
- **Prove here:** WAL detection works, and a `{ readonly: true }` handle rejects a write.

### Slice 2 — Read path (ship point)
Port to `core.js` (pure) + `server.js` (routes):
- `GET /tables` → `{ tables:[{name,type,rows}] }`, hiding `sqlite_%` (make the extra
  hidden-name set configurable, default just the sidecar/internal names).
- `GET /schema/:table` → `{ name,type,ddl,columns,indexes,foreignKeys }`.
- `POST /check` → parse-only via prepare+finalize on the **readonly** handle; `{ ok, readOnly }`.
- `POST /run` (read branch): readonly handle, `MAX_ROWS=1000` cap, `{ mode:"read",
  columns, rows, rowCount, capped, maxRows, ms }`.
- Port the statement helpers verbatim: `stripLeading`, `READ_STARTERS`, `looksReadOnly`,
  `splitCount`, `rejectMultiple` (multi-statement → 400 "One statement per run", trailing `;` OK).
- **Port + green:** the readonly-boundary test (incl. the disguised `WITH x AS (SELECT 1)
  DELETE ...` → SQLite `readonly database` error), the multi-statement test, the row-cap and
  SELECT-shape tests, the check-validates-without-executing test.
- Minimal results grid in the client so read-only is usable. **This is the ship-here point.**

### Slice 3 — UI polish (the large piece: Shadow DOM port)
Port `sql-workbench.js` → `src/client/workbench.js`, converting **light DOM + Tailwind
utility classes → Shadow DOM + `static styles = css` template** self-contained CSS (this is
the one non-trivial UI change — every `class="…"` in the template needs a CSS equivalent).
- Replace `../base.js` `LightDomElement` with a normal `LitElement` (default shadow root);
  replace `../api.js` helpers with a small in-component `fetch` wrapper hitting the
  configurable base path.
- Features to carry over: tables/snippets sidebar, tabbed editor (query/browse/read-only
  schema tabs), drag-to-resize splitter, results grid filling remaining height; Format
  (`sql-formatter`, lazy-loaded), Check, Run; both-axis scroll, single-line rows, cells >40
  chars truncated → click-for-modal, zebra striping, `text-xs`; tabs persisted via
  `sessionStorage`; **Document schema** modal (tick tables → download Markdown of their
  `CREATE TABLE`s in ```sql fences); CSV/text export; the static SQL colouring for schema DDL.
- `src/client/index.html`: minimal shell mounting `<sqlite-workbench>`; served by the server.
- Decide Lit delivery (bundle with `bun build`, or ESM import map) — recommend `bun build`
  the client into a served asset so there's no CDN dependency.

### Slice 4 — Write path (`--write`)
- No write handle is even opened without `--write` (process-level least privilege).
- `POST /run` write branch: `canWrite` gate → friendly 403 `code:"read_only"` for readers;
  `BEGIN IMMEDIATE`; `db.run(sql).changes`; `COMMIT` only when `body.commit===true`, else
  `ROLLBACK`; return `{ mode:"write", committed, rowsAffected, snapshot, ms, message }` with
  the dry-run message "N rows would change / Re-run with Commit".
- **Pre-commit snapshot** (`takeSnapshot`): `VACUUM INTO` a timestamped file in a snapshot dir
  (config, default `<db-dir>/sql-snapshots`), rotate keeping last 10, **fail closed** (no
  snapshot → 500, statement not run). Snapshot only on commit, never on dry run.
- Audit via the injected `onExecute` sink (default: `audit` table in sidecar SQLite).
- **Client:** show "Commit change" only for an uncommitted write result.
- **Port + green:** rollback-by-default-then-commit test, and snapshot-is-pre-write test
  (dry run adds no snapshot; committed write's snapshot shows the state *before* the row).

### Slice 5 — Snippets (sidecar SQLite)
- `src/server/snippets.js`: on first use, create/open `<db>.workbench.sqlite` with a
  `snippets(id, name, sql, owner, created, updated)` table (idempotent, WAL). `--snippets-in-db`
  opt-in creates `sql_snippets` in the target DB instead.
- Routes: `GET/POST/PUT/DELETE /snippets`, owner-or-admin edit/delete. `owner` comes from
  the auth policy's identity (Slice 6); in no-auth dev mode default owner e.g. `"local"`.
- **Port + green:** the snippets CRUD + owner-only-edit/delete test (rewrite its admin
  harness for the new auth model).

### Slice 6 — Auth modes
`src/server/auth.js` provides `canRead(req)` / `canWrite(req)` + an identity (`who`) resolver.
Modes selected by CLI flags:
- **dev (default):** loopback only; optional single shared password (`--password` or env).
  No auth on loopback if no password set. Read/write governed by `--write`.
- **sidecar:** validate the host app's session cookie against a shared `sessions`-style table
  in the target DB, using `hashSessionId` (ported from `sessionId.js`) — works because the
  reference stores session ids hashed. Config points at the session table/column + cookie name.
- Wire the policy into `server.js` so `core.js` stays framework/auth-agnostic.

## Key risks / must-not-get-wrong

- **The readonly connection is the boundary.** Statement sniffing is UX only. The disguised-
  write test must stay green — it *is* the product.
- **Two processes, one SQLite file.** Require/warn WAL; `busy_timeout` so writes wait rather
  than `SQLITE_BUSY`; document that a long workbench write can briefly block the host app.
  Never silently change someone's journal mode.
- **Fail closed on snapshots.** No restore point → don't do the risky write.
- **Don't touch the target schema uninvited** — snippets/audit default to the sidecar file.
- **File permissions:** the process must read+write the DB file (run as the app's service
  account when deployed as a sidecar); document it.

## Verification

- **Primary gate — safety tests:** `bun test test/safety.test.js` green after each slice that
  ports tests (2, 4, 5). The readonly-boundary + snapshot + rollback tests are the definition
  of done for the core.
- **Manual smoke per slice:** create a throwaway WAL DB (`bun` one-liner or `sqlite3`), run
  `bun bin/cli.js ./scratch.db` → open `http://127.0.0.1:9999`, confirm "connected: N tables";
  run a SELECT; try a disguised write as read-only (expect rejection); with `--write`, do a
  dry-run INSERT (rolls back), then Commit (persists, snapshot file appears); save/edit/delete
  a snippet and confirm it lands in `<db>.workbench.sqlite`, not the target DB.
- **WAL warning:** point at a non-WAL DB, confirm the loud warning and that journal mode is
  unchanged unless `--set-wal`.
- Add a `bun test` script + a short README quickstart mirroring the handoff's three example
  invocations.

## Open items to decide during build (defaults chosen, revisit if needed)
- Client Lit delivery: `bun build` bundle (recommended) vs import map.
- Exact sidecar-auth config surface (session table/column/cookie names) — start minimal,
  driven by real host-app shape.
- Compiled single binary (`bun build --compile`) — deferred; layout keeps it possible.
