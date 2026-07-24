# SQLite Workbench — standalone tool (handoff / design brief)

> **Read this first.** This is a fresh, empty repo. Everything here is the plan
> and the context — there is no code yet. A working reference implementation
> exists in another project (see [Reference implementation](#reference-implementation));
> this project **extracts and generalises** it into a standalone tool.
>
> This doc is self-contained: you do **not** need the conversation it came from.

---

## What we're building

A **standalone, single-purpose web tool** for querying and safely editing a
**SQLite** database, run alongside (not inside) whatever app owns that database.

The pitch: point it at a `.sqlite` file, get a browser SQL workbench — browse
tables, run queries, edit data with guard rails, save snippets, export results,
document the schema. Works next to an app in **any** language, because the only
thing it needs is the SQLite file.

```bash
sqlite-workbench ./app.db                 # -> http://127.0.0.1:9999, read-only
sqlite-workbench ./app.db --write         # opt in to editing
sqlite-workbench ./app.db --port 8080 --host 127.0.0.1
```

**Scope: SQLite only.** No Postgres/MySQL. The core safety guarantee (below) is
SQLite-specific, and multi-DB support would be a different, more careful project.

---

## Decisions already made (don't relitigate without reason)

These came out of a prior design discussion; they're settled starting points:

1. **Standalone server, not a library.** A library only helps JS apps you can
   modify. A standalone server that opens a `.sqlite` file helps *any* app on
   the box (Python, Go, static site, or no app at all). That generality is the
   whole point.
2. **SQLite only.**
3. **localhost by default.** Binds `127.0.0.1` unless told otherwise. A tool
   that can `DELETE FROM` should not be internet-reachable by default; reach it
   over an SSH tunnel. `--host 0.0.0.0` is an explicit opt-in.
4. **Read-only by default; `--write` to enable editing.** Least privilege at the
   process level, on top of the per-connection guarantee below.
5. **The read-only *connection* is the security boundary — not string matching.**
   See [Safety model](#the-safety-model). This is the crown jewel; everything
   else is secondary.
6. **Two-step writes.** A write runs in a transaction that is **rolled back**
   unless the user explicitly commits — so the default outcome of a mistake is
   "nothing happened, here's the row count it *would* have changed".
7. **Snapshot before every committed write.** `VACUUM INTO` a timestamped copy
   first, giving an exact restore point per statement. Fail closed: if the
   snapshot can't be taken, the write doesn't run.
8. **One statement per run.** Multiple editor tabs, but one statement executes
   at a time — far safer and simpler than multi-statement parsing.
9. **Runtime: Bun** (matches the reference impl and gives `bun:sqlite` for free).
   Open question: whether to also support Node via an adapter — see
   [Open questions](#open-questions).

---

## The safety model (the crown jewel — get this right or don't ship)

The single most important idea: **a read-only user runs on a SQLite connection
opened `{ readonly: true }`.** SQLite itself then refuses any write, no matter
what SQL is typed. This defeats every bypass that statement-sniffing misses:
`WITH x AS (...) DELETE ...`, a `PRAGMA`, a trigger, etc.

> Statement sniffing (regex for a leading `SELECT`) exists ONLY to give a
> friendly error and to choose the read-vs-write connection. It is **never** the
> security control. The reference impl has a test that proves a disguised write
> (`WITH x AS (SELECT 1) DELETE ...`) submitted by a read-only user is rejected
> by SQLite — port that test; it *is* the product.

The layers, in order:

| Layer | What it does |
|---|---|
| Read-only connection | SQLite refuses writes on it — the hard boundary for read users |
| `--write` flag | Process-level: no write connection is even opened without it |
| `canWrite()` policy | Per-request: who may write (host-injected; see Generalising) |
| Transaction + explicit commit | A write rolls back unless committed; reports "N rows would change" |
| Pre-commit snapshot | `VACUUM INTO` restore point before each committed write; fail-closed |
| Audit sink | Every executed statement recorded (who/sql/rows/committed) |
| Row cap + busy_timeout | Can't flood the browser or wedge the host app |

### The one genuine technical risk: two processes, one SQLite file

This tool is a **second process** writing a file the host app also writes.
SQLite is single-writer. So:

- **Require WAL mode.** Detect the journal mode on startup; if it's not WAL,
  **warn loudly** (concurrent access will be contentious) but do **not** silently
  flip someone else's journal mode. Consider a `--set-wal` opt-in flag.
- **`busy_timeout`** (e.g. 5s) so a write waits for the app's write instead of
  erroring with `SQLITE_BUSY`.
- **Document the caveat:** a long workbench write transaction can briefly block
  the host app's writes and vice-versa. Fine for small/internal apps; state it
  plainly for high-write ones.

The read-only guarantee, snapshots, and transactions are all **per-connection**,
so they work perfectly across processes — only write *contention* is the issue.

### File permissions (learned the hard way)

The workbench process must **read and write** the DB file, so it has to run as a
user in the file's group. In dev this is nothing; as a deployed sidecar it means
running it as the app's service account (same as any co-located process).

---

## What must be generalised (vs the reference impl)

The reference is wired into one specific app. These are the seams to cut so it
stands alone:

1. **DB path from CLI/config**, not a hard-coded resolve. (Reference resolves
   `../db/aph2.sqlite`; export/accept the path instead.)
2. **Auth → injected policy.** Reference gates on `admin_users` role flags
   (`sql_read` / `sql_write`) via `c.get("admin")`. Standalone can't assume that
   table. Provide `canRead(req)` / `canWrite(req)` hooks with sensible defaults:
   - **dev mode:** localhost + optional single shared password (or no auth on
     loopback).
   - **sidecar mode:** validate the host app's session cookie against a shared
     `sessions`-style table in the *same DB* (works precisely because the
     reference now stores session ids **hashed** — see the sessionId note below).
3. **Audit → injected sink.** Reference writes to the app's `audit_log` table.
   Standalone should default to a log file (or its own table), via an
   `onExecute({ sql, rowsAffected, committed, who })` callback.
4. **Snippets store → pluggable / optional.** Reference keeps a `sql_snippets`
   table *in the target DB*. A generic tool shouldn't create tables in someone's
   schema uninvited: default to a **sidecar file** (e.g. `<db>.workbench.json`
   or a separate `<db>.workbench.sqlite`), with an opt-in to use an in-DB table.
5. **Styling → Shadow DOM.** Reference uses light DOM so the host app's Tailwind
   cascades in. Standalone wants the opposite: **Shadow DOM + self-contained
   styles** so it can't depend on (or leak into) any host page. This is the one
   non-trivial UI change.
6. **Config for caps:** row cap (default 1000), busy_timeout (5s), snapshot dir
   + retention (keep last 10).
7. **Framework-agnostic server core.** Reference uses Hono. Aim for a core that
   returns plain `(req) → res` handlers, with a thin Bun.serve wrapper. (Only
   matters if Node support is later wanted.)

---

## The API contract (copy verbatim — the UI depends on these shapes)

All under a base path (reference uses `/api/sql`; standalone can use `/api` or
configurable). `canRead` gates everything; `canWrite` gates the write path.

| Method / path | Purpose | Response (shape) |
|---|---|---|
| `GET /tables` | list tables + views + row counts | `{ tables: [{ name, type, rows }] }` (hide internal tables like `sqlite_%`, and app plumbing) |
| `GET /schema/:table` | columns, indexes, FKs, DDL | `{ name, type, ddl, columns[], indexes[], foreignKeys[] }` |
| `POST /check` | parse-only; **never executes** | `{ ok, readOnly }` or `{ ok:false, error }` |
| `POST /run` | execute ONE statement | read: `{ mode:"read", columns[], rows[], rowCount, capped, maxRows, ms }` · write: `{ mode:"write", committed, rowsAffected, snapshot, ms, message }` |
| `GET /snippets` | list saved queries | `{ snippets: [{ id, name, sql, owner, created, updated }] }` |
| `POST /snippets` | create `{ name, sql }` | `{ snippet }` (201) |
| `PUT /snippets/:id` | update (owner or admin only) | `{ snippet }` |
| `DELETE /snippets/:id` | delete (owner or admin only) | `{ ok:true }` |

`POST /run` body: `{ sql, commit? }`. `commit:true` is only meaningful for a
write, and it's the second step (first Run = dry run that rolls back).

Multi-statement input → 400 with "One statement per run." A single trailing `;`
is allowed.

### Client UI features (all already built in the reference)

- Full-viewport, desktop-only layout: tables/snippets sidebar, tabbed editor
  (query + browse + read-only schema tabs), drag-to-resize splitter, results
  grid filling remaining height.
- **Format** button (`sql-formatter`, lazy-loaded), **Check**, **Run**,
  **Commit change** (only shown for an uncommitted write).
- Results: both-axis scroll, single-line rows, cells >40 chars truncated →
  click for a modal with the full value, zebra striping, `text-xs`.
- Tabs persist across navigation/refresh via `sessionStorage` (scratch state;
  snippets are the durable path).
- **Document schema:** modal to tick tables → downloads a Markdown file of their
  `CREATE TABLE` statements (```sql fences, so it highlights when rendered).
- Snippets: shared list, owner-only edit/delete.
- CSV / text export.

---

## Reference implementation

A complete, tested version lives in the **aph2-diary** project. Copy from these
absolute paths (they won't exist in this repo):

| File | What it has |
|---|---|
| `/var/home/rcollins/code/aph2-diary/server/routes/sql.js` | All server logic: readonly connection, run/check, transactions + commit, `VACUUM INTO` snapshots + rotation, audit, snippets CRUD, table/schema list. **The safety core.** |
| `/var/home/rcollins/code/aph2-diary/client/src/components/sql-workbench.js` | The whole UI (Lit, light DOM). Port to Shadow DOM. |
| `/var/home/rcollins/code/aph2-diary/tests/tier2/sql.test.js` | The safety tests — **port these first and keep them green through the refactor.** Includes the disguised-write-rejected test and the snapshot-is-pre-write test. |
| `/var/home/rcollins/code/aph2-diary/server/db.js` | Pattern for exporting the resolved `dbPath` and idempotent side-table creation. |
| `/var/home/rcollins/code/aph2-diary/server/lib/sessionId.js` | Why session ids are **hashed** (SHA-256) not stored raw — relevant if sidecar mode validates the host app's session table. |
| `/var/home/rcollins/code/aph2-diary/docs/user_guide_sql_workbench.md` | End-user guide; good basis for this tool's README. |

> Note: the reference is licensed as part of a private project. If this becomes
> public, treat the reference as *your own* prior work to reuse — no third-party
> code involved.

---

## Proposed layout for this repo

```
sqlite-workbench/
  bin/cli.js              # arg parsing -> starts the server
  src/server/
    core.js              # framework-agnostic handlers (the safety core)
    sqlite.js            # bun:sqlite adapter: ro/rw connections, snapshot, WAL check
    auth.js              # canRead/canWrite defaults (localhost / password / shared-session)
    snippets.js          # sidecar snippet store (+ optional in-DB)
  src/client/
    workbench.js         # the Shadow-DOM web component
    index.html           # minimal shell that mounts <sqlite-workbench>
  test/
    safety.test.js       # PORTED FIRST: readonly boundary, rollback, snapshot
  README.md
  HANDOFF.md             # this file
```

---

## Build order (each slice independently runnable)

1. **CLI + server skeleton** — `sqlite-workbench <db>` opens the file, serves a
   page that says "connected: N tables", binds localhost. Prove WAL detection +
   the readonly connection open here.
2. **Read path** — `/tables`, `/schema/:table`, `/run` (SELECT only), results
   grid. **Port the readonly-boundary + row-cap tests.** Ship here — read-only
   is ~60% of the value at ~40% of the risk.
3. **UI polish** — tabs, splitter, schema tabs, formatter, export, cell modal,
   sessionStorage persistence, Document-schema. (Port from reference; convert to
   Shadow DOM.)
4. **Write path** (`--write`) — transactions, dry-run/commit, snapshots, audit.
   **Port the rollback + snapshot tests.**
5. **Snippets** — sidecar store.
6. **Auth modes** — password + shared-session for sidecar deployment.

---

## Open questions (decide as you go)

- **Node support?** Bun-only is simplest (`bun:sqlite`, single binary via `bun
  build --compile`). Node would need `better-sqlite3`/`node:sqlite` behind the
  adapter. Recommend: **Bun-only to start.**
- **Distribution:** `npx`/`bunx` script, or a compiled single binary
  (`bun build --compile`)? The compiled binary is the truest "drop in anywhere".
- **Snippet store default:** sidecar JSON vs sidecar SQLite vs in-DB table.
  Leaning sidecar file so the target schema is never touched.
- **Sidecar auth:** how much to standardise validating a host app's session
  table vs leaving it to a `canRead`/`canWrite` the user writes.

---

## First action for the new session

Scaffold slice 1 (CLI + server skeleton + WAL/readonly proof), then port
`test/safety.test.js` from the reference and make the readonly-boundary test pass
against the new adapter. The safety tests moving green through the refactor is
the definition of done for the core.
