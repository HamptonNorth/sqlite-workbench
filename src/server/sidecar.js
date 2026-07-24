// The sidecar SQLite file: <db>.workbench.sqlite, kept next to the target DB.
//
// A generic tool shouldn't create tables in someone else's schema uninvited, so
// the workbench's own bookkeeping - the audit trail now, saved snippets in a
// later slice - lives here instead of in the target database.
//
// Opened LAZILY: a purely read-only browsing session never writes anything, so
// no sidecar file appears until the first thing that needs to be recorded (an
// executed write). WAL, because it's ours and we may as well.

import { Database } from "bun:sqlite";

export function sidecarPath(targetDbPath) {
  return `${targetDbPath}.workbench.sqlite`;
}

export function openSidecar(targetDbPath) {
  const path = sidecarPath(targetDbPath);
  let db = null;

  function handle() {
    if (!db) {
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
      `);
    }
    return db;
  }

  // Record every executed statement (dry runs included, flagged uncommitted).
  // The snapshot column names the restore point for a committed write, so the
  // audit row tells you which file to roll back to.
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

  function close() {
    try { db?.close(); } catch { /* ignore */ }
    db = null;
  }

  return { path, appendAudit, close, handle };
}
