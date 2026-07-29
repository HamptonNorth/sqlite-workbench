// The sidecar SQLite file: .workbench/<db>.sqlite, in a subfolder beside the
// target DB.
//
// A generic tool shouldn't create tables in someone else's schema uninvited, so
// the workbench's own bookkeeping - the audit trail, saved snippets and (opt-in)
// open-tab state - lives here instead of in the target database.
// (--snippets-in-db is an explicit opt-in to store snippets in the target DB as
// a `sql_snippets` table instead.)
//
// It used to live at `<db>.workbench.sqlite`, i.e. sharing the database's own
// filename prefix. That made it collateral damage of the most natural way to
// force a clean rebuild - `rm out/app.db*` matches the sidecar too, and takes
// every saved snippet with it silently. The subfolder is outside that glob.
// Sidecars at the old path are moved on open; see migrateLegacySidecar.
//
// Opened LAZILY: a purely read-only browsing session that never saves a snippet
// writes nothing, so no sidecar file appears until the first thing that needs to
// be recorded. WAL, because it's ours and we may as well.

import { Database } from "bun:sqlite";
import { dirname, basename, join } from "node:path";
import { existsSync, mkdirSync, renameSync } from "node:fs";

export function sidecarPath(targetDbPath) {
  return join(dirname(targetDbPath), ".workbench", `${basename(targetDbPath)}.sqlite`);
}

export function legacySidecarPath(targetDbPath) {
  return `${targetDbPath}.workbench.sqlite`;
}

// Move a pre-existing sidecar to the new location, WAL and shm with it. Only
// when the new path is absent, so a half-migrated pair never clobbers live data.
// Returns the path moved from, or null. Best-effort: a failure here must not
// stop the workbench opening.
export function migrateLegacySidecar(targetDbPath) {
  const from = legacySidecarPath(targetDbPath);
  const to = sidecarPath(targetDbPath);
  if (!existsSync(from) || existsSync(to)) return null;
  try {
    mkdirSync(dirname(to), { recursive: true });
    renameSync(from, to);
    for (const suffix of ["-wal", "-shm"]) {
      if (existsSync(from + suffix)) renameSync(from + suffix, to + suffix);
    }
    return from;
  } catch {
    return null;
  }
}

const SNIPPET_COLS = "id, name, sql, owner, created, updated";

export function openSidecar(targetDbPath, { snippetsInDb = false } = {}) {
  const path = sidecarPath(targetDbPath);
  const snippetTable = snippetsInDb ? "sql_snippets" : "snippets";

  let db = null;   // the sidecar file (audit; snippets unless --snippets-in-db)
  let tdb = null;  // the target DB, only opened for --snippets-in-db snippets

  function snippetDdl(table) {
    return `
      CREATE TABLE IF NOT EXISTS ${table} (
        id      INTEGER PRIMARY KEY,
        name    TEXT NOT NULL,
        sql     TEXT NOT NULL,
        owner   TEXT,
        created TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
        updated TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
      );
      CREATE INDEX IF NOT EXISTS idx_${table}_name ON ${table}(name);
    `;
  }

  // The sidecar handle: audit always, plus snippets unless they live in-DB, plus
  // the ui_state key/value table backing opt-in tab persistence.
  function handle() {
    if (!db) {
      mkdirSync(dirname(path), { recursive: true });
      db = new Database(path);
      db.exec("PRAGMA journal_mode = WAL");
      db.exec(`
        CREATE TABLE IF NOT EXISTS audit (
          id            INTEGER PRIMARY KEY,
          at            TEXT    NOT NULL DEFAULT (CURRENT_TIMESTAMP),
          who           TEXT,
          sql           TEXT    NOT NULL,
          rows_affected INTEGER,
          committed     INTEGER NOT NULL,
          snapshot      TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_audit_at ON audit(at);

        CREATE TABLE IF NOT EXISTS ui_state (
          key     TEXT PRIMARY KEY,
          value   TEXT NOT NULL,
          updated TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
        );
      `);
      if (!snippetsInDb) db.exec(snippetDdl("snippets"));
    }
    return db;
  }

  // Where snippets live. Default: the sidecar handle above. --snippets-in-db:
  // a separate writable handle to the TARGET database (an explicit opt-in to
  // touch its schema), holding a `sql_snippets` table.
  function snippetDb() {
    if (!snippetsInDb) return handle();
    if (!tdb) {
      tdb = new Database(targetDbPath); // read/write
      tdb.exec("PRAGMA busy_timeout = 5000");
      tdb.exec(snippetDdl("sql_snippets"));
    }
    return tdb;
  }

  // ---- audit ----------------------------------------------------------------
  // Record every executed statement (dry runs included, flagged uncommitted).
  // The snapshot column names the restore point for a committed write.
  function appendAudit({ who = null, sql, rowsAffected = null, committed, snapshot = null }) {
    handle()
      .query(`
        INSERT INTO audit (who, sql, rows_affected, committed, snapshot)
        VALUES ($who, $sql, $rows, $committed, $snapshot)
      `)
      .run({
        $who: who,
        $sql: String(sql ?? ""),
        $rows: rowsAffected,
        $committed: committed ? 1 : 0,
        $snapshot: snapshot,
      });
  }

  // ---- snippets -------------------------------------------------------------
  function listSnippets() {
    return snippetDb().query(`SELECT ${SNIPPET_COLS} FROM ${snippetTable} ORDER BY name`).all();
  }
  function getSnippet(id) {
    return snippetDb().query(`SELECT ${SNIPPET_COLS} FROM ${snippetTable} WHERE id = $id`).get({ $id: id }) ?? null;
  }
  function createSnippet({ name, sql, owner = null }) {
    const { id } = snippetDb()
      .query(`INSERT INTO ${snippetTable} (name, sql, owner) VALUES ($name, $sql, $owner) RETURNING id`)
      .get({ $name: name, $sql: sql, $owner: owner });
    return getSnippet(id);
  }
  function updateSnippet(id, { name, sql }) {
    snippetDb()
      .query(`UPDATE ${snippetTable} SET name = $name, sql = $sql, updated = CURRENT_TIMESTAMP WHERE id = $id`)
      .run({ $id: id, $name: name, $sql: sql });
    return getSnippet(id);
  }
  function deleteSnippet(id) {
    snippetDb().query(`DELETE FROM ${snippetTable} WHERE id = $id`).run({ $id: id });
  }

  // ---- ui state -------------------------------------------------------------
  // Opaque JSON blobs keyed by name, used for open-tab persistence. The server
  // decides whether to expose it at all (--persist-tabs); the store just holds
  // whatever it is given. Reading never creates the sidecar file: a session that
  // has nothing saved should still write nothing.
  function getUiState(key) {
    if (!db && !existsSync(path)) return null;
    const row = handle().query("SELECT value FROM ui_state WHERE key = $key").get({ $key: key });
    return row ? row.value : null;
  }
  function setUiState(key, value) {
    handle()
      .query(`
        INSERT INTO ui_state (key, value) VALUES ($key, $value)
        ON CONFLICT(key) DO UPDATE SET value = $value, updated = CURRENT_TIMESTAMP
      `)
      .run({ $key: key, $value: value });
  }
  function clearUiState(key) {
    if (!db && !existsSync(path)) return;
    handle().query("DELETE FROM ui_state WHERE key = $key").run({ $key: key });
  }

  function close() {
    try { db?.close(); } catch { /* ignore */ }
    try { tdb?.close(); } catch { /* ignore */ }
    db = tdb = null;
  }

  return {
    path,
    snippetTable,
    appendAudit,
    listSnippets, getSnippet, createSnippet, updateSnippet, deleteSnippet,
    getUiState, setUiState, clearUiState,
    close, handle,
  };
}
