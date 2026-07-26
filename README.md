# sqlite-workbench

A standalone, single-purpose web tool for **querying and safely editing a SQLite
database**, run alongside (not inside) whatever app owns that database.

Point it at a `.sqlite` file and get a browser SQL workbench — browse tables, run
queries, edit data with guard rails, save snippets, export results, document the
schema. It works next to an app in **any** language, because the only thing it
needs is the SQLite file.

```bash
sqlite-workbench ./app.db                 # → http://127.0.0.1:9999, read-only
sqlite-workbench ./app.db --write         # opt in to editing
sqlite-workbench ./app.db --port 8080 --host 127.0.0.1
```

> **Scope: SQLite only.** No Postgres/MySQL — the core safety guarantee below is
> SQLite-specific.

---

## Why

Small internal apps often have a lookup table or a bit of data with no admin UI.
A year later you need to change one row and there's nowhere to do it safely. This
gives you that place — with the guard rails to not shoot yourself in the foot,
and an [operations workflow](docs/OPERATIONS.md) for doing it on a remote server.

## The safety model (the crown jewel)

The single most important idea: **a read-only user runs on a SQLite connection
opened `{ readonly: true }`.** SQLite itself then refuses any write, no matter
what SQL is typed — even a disguised one like `WITH x AS (SELECT 1) DELETE …`.
The connection is the boundary, **not** string-matching on the SQL. (Statement
sniffing exists only to give a friendly error and pick the read-vs-write path;
it is never the security control.) The test that proves this lives in
[`test/safety.test.js`](test/safety.test.js) and is the definition of done.

Layered on top:

| Layer | What it does |
|---|---|
| Read-only connection | SQLite refuses writes on it — the hard boundary for read users |
| `--write` flag | No write connection is even opened without it |
| Two-step writes | A write runs in a transaction that **rolls back** unless you explicitly commit — a mistyped `UPDATE` reports "N rows would change" and changes nothing |
| Pre-commit snapshot | `VACUUM INTO` a timestamped restore point before every committed write; **fails closed** (no snapshot → the write doesn't run) |
| Audit trail | Every executed statement recorded (who / sql / rows / committed / snapshot) |
| Row cap + `busy_timeout` | A runaway query can't flood the browser or wedge the host app |

Snippets and the audit trail live in a **sidecar file** (`<db>.workbench.sqlite`)
next to your database — the tool never creates tables in the target schema
uninvited.

## Requirements

- [Bun](https://bun.sh) ≥ 1.3 (uses `bun:sqlite`; the UI is bundled in-process,
  no separate build step, no CDN).

## Quick start

```bash
git clone git@github.com:HamptonNorth/sqlite-workbench.git
cd sqlite-workbench
bun install

# read-only against your own scratch DB in ./data
bun run dev ./data/app.db

# enable editing
bun run dev ./data/app.db --write
```

Open the printed `http://127.0.0.1:9999` in your browser (desktop only).

## CLI

```
sqlite-workbench <db.sqlite> [options]

Options:
  --write              enable editing (default: read-only)
  --port <n>           port to listen on (default: 9999)
  --host <addr>        address to bind (default: 127.0.0.1; use 0.0.0.0 to expose)
  --base <path>        API base path (default: /api)
  --data-dir <path>    databases the UI may switch to (default: the DB's folder)
  --set-wal            switch the DB to WAL journal mode (persistent; explicit opt-in)
  --snippets-in-db     store snippets in the target DB instead of the sidecar
  -h, --help           show help
```

## What the UI gives you

- Full-viewport, desktop-only layout: tables/snippets sidebar, tabbed editor,
  drag-to-resize splitter, results grid.
- **Format** (via `sql-formatter`), **Check** (parse-only), **Run**, and — for a
  write — **Run and Commit Change** (the two-step commit).
- Results grid: both-axis scroll, single-line rows, long cells truncated with a
  click-for-full-value modal, zebra striping, CSV / text export.
- Read-only **schema tabs** (columns, indexes, FKs, `CREATE` statement).
- **Document schema**: tick tables → download a Markdown file of their `CREATE`
  statements.
- **Snippets**: saved queries, **per database**, shared across users, owner-only
  edit/delete.
- **Connect to** selector: switch between local databases in the data dir, or
  see the ops commands for a remote project.
- Tab state persists across refresh via `sessionStorage` (snippets are the
  durable path).

## Supporting a remote database

For the "stop the service, edit the live DB, put it back" case there's a thin,
reviewable ops layer driven by a project registry — see
**[docs/OPERATIONS.md](docs/OPERATIONS.md)**. In short:

```bash
cp projects.example.json projects.json          # add your hosts/paths (git-ignored)

bun run scripts/remote.js investigate <project>  # read-only, on a downloaded copy
bun run scripts/remote.js edit        <project>  # stop → download → edit → verify → upload → restart
```

The scripts print every `ssh`/`scp` command, support `--dry-run`, and can emit a
runnable bash script (`--script`) so you can read and run it by hand — trust
nothing you haven't read. Guard rails: back up the remote original, verify with
`PRAGMA integrity_check`, refuse to upload if the remote changed under you, and
support service-owned databases via a per-project `"sudo": true`.

## The one caveat: two processes, one SQLite file

This tool is a **second process** writing a file the host app also writes, and
SQLite is single-writer. So:

- **WAL is recommended.** The tool detects the journal mode on startup and warns
  (loudly, once) if it isn't WAL; it never flips someone else's journal mode
  silently. `--set-wal` opts in.
- A `busy_timeout` makes a write wait for the app's write instead of erroring.
- A long workbench write can briefly block the host app's writes and vice-versa.
  Fine for small/internal apps; state it plainly for high-write ones.
- Bind to `127.0.0.1` (the default) and reach it over an SSH tunnel; a tool that
  can `DELETE FROM` should not be internet-reachable. `--host 0.0.0.0` is an
  explicit opt-in.

## Development

```bash
bun test            # runs test/safety.test.js — the safety guarantees
```

Layout:

```
bin/cli.js            # arg parsing → starts the server + friendly banner
src/server/
  core.js             # framework-agnostic request handlers (the safety core)
  sqlite.js           # bun:sqlite: ro/rw connections, snapshots, WAL check
  server.js           # Bun.serve wrapper; switchable connection; serves the UI
  sidecar.js          # <db>.workbench.sqlite: audit trail + snippets
  registry.js         # project registry loader
  opsplan.js          # generates the runnable ops scripts
src/client/
  workbench.js        # the Shadow-DOM <sqlite-workbench> web component
  index.html          # minimal shell that mounts it
scripts/remote.js     # investigate / edit dispatcher for remote projects
test/safety.test.js   # the read-only boundary, rollback, and snapshot tests
docs/OPERATIONS.md    # the remote-support runbook
```

Runtime is Bun-only for now (single `src/server/sqlite.js` adapter keeps a future
Node port isolated).

## License

[MIT](LICENSE).
