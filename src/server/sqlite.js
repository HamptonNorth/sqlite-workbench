// The SQLite layer. Everything that touches bun:sqlite lives here, so a future
// Node port (better-sqlite3 / node:sqlite) only has to reimplement this file.
//
// SAFETY MODEL - read this before changing anything here.
//
// The permission boundary is the CONNECTION, not string-matching on the SQL.
// A read-only user runs on a handle opened { readonly: true }, so SQLite itself
// rejects any write - no amount of creative SQL ("WITH x AS (...) DELETE", a
// PRAGMA, a trigger) can get past it. Statement sniffing elsewhere exists only
// to give a friendly error and to pick read-vs-write intent; it is NEVER the
// security control.
//
// Two processes, one file: this tool is a SECOND process writing a file the
// host app also writes. SQLite is single-writer, so we require WAL (warn loudly
// if it isn't; never flip someone's journal mode silently) and set a
// busy_timeout so a write waits for the app's write instead of erroring.

import { Database } from "bun:sqlite";
import { resolve } from "node:path";

export const DEFAULT_BUSY_TIMEOUT_MS = 5000;

// Objects that are plumbing rather than data worth querying. sqlite_% is filtered
// in SQL; the sidecar workbench file (if it ever lands in the same dir) and these
// names are filtered here. PRESENTATIONAL ONLY - hiding a name is not access
// control, both are still queryable by anyone who types the name.
const DEFAULT_HIDDEN = new Set(["sqlite_sequence", "sqlite_stat1"]);

// Read the persistent journal mode WITHOUT changing it. Done on a throwaway
// readonly handle so probing can't have a side effect.
function probeJournalMode(path) {
  const probe = new Database(path, { readonly: true });
  try {
    const row = probe.query("PRAGMA journal_mode").get();
    return String(row?.journal_mode ?? "").toLowerCase();
  } finally {
    probe.close();
  }
}

/**
 * Open the workbench's connections to a SQLite file.
 *
 * @param {object} opts
 * @param {string} opts.dbPath      path to the target .sqlite file
 * @param {boolean} [opts.write]    whether a read/write handle may be opened
 * @param {boolean} [opts.setWal]   explicit opt-in to flip journal mode to WAL
 * @param {number} [opts.busyTimeout]
 * @param {Set<string>} [opts.hidden] extra table names to hide from listings
 * @returns handles + metadata; nothing is opened lazily until first use.
 */
export function openSqlite({
  dbPath,
  write = false,
  setWal = false,
  busyTimeout = DEFAULT_BUSY_TIMEOUT_MS,
  hidden = DEFAULT_HIDDEN,
} = {}) {
  const path = resolve(dbPath);

  let journalMode = probeJournalMode(path);

  // --set-wal is the ONLY path that changes the file's journal mode, and it is
  // an explicit user opt-in. WAL is persistent, so a writable handle is needed.
  if (setWal && journalMode !== "wal") {
    const rw = new Database(path, { readwrite: true });
    try {
      const row = rw.query("PRAGMA journal_mode = WAL").get();
      journalMode = String(row?.journal_mode ?? "").toLowerCase();
    } finally {
      rw.close();
    }
  }

  // A second, READONLY handle. This is the real gate for read-only users:
  // SQLite refuses any write on it regardless of the SQL. Lazy so a DB that's
  // never queried pays nothing.
  let _ro = null;
  function readonlyDb() {
    if (!_ro) {
      _ro = new Database(path, { readonly: true });
      _ro.exec(`PRAGMA busy_timeout = ${busyTimeout}`);
    }
    return _ro;
  }

  // The read/write handle. Only reachable when the process was started --write,
  // so a read-only deployment can't even open a writable connection.
  let _rw = null;
  function writeDb() {
    if (!write) throw new Error("write access is disabled (start with --write)");
    if (!_rw) {
      _rw = new Database(path, { readwrite: true });
      _rw.exec(`PRAGMA busy_timeout = ${busyTimeout}`);
      _rw.exec("PRAGMA foreign_keys = ON");
    }
    return _rw;
  }

  // Tables + views + row counts, for the sidebar and the "connected: N" page.
  function listTables() {
    const ro = readonlyDb();
    const objs = ro
      .query(`
        SELECT name, type FROM sqlite_master
        WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%'
        ORDER BY type, name
      `)
      .all()
      .filter((o) => !hidden.has(o.name));
    return objs.map((o) => {
      let rows = null;
      // Names come from sqlite_master, but quote defensively anyway.
      try {
        rows = ro.query(`SELECT COUNT(*) AS n FROM "${o.name.replace(/"/g, '""')}"`).get().n;
      } catch {
        /* a view can fail to count; leave null */
      }
      return { name: o.name, type: o.type, rows };
    });
  }

  function close() {
    try { _ro?.close(); } catch { /* ignore */ }
    try { _rw?.close(); } catch { /* ignore */ }
    _ro = _rw = null;
  }

  return {
    dbPath: path,
    journalMode,
    isWal: journalMode === "wal",
    canWrite: write,
    readonlyDb,
    writeDb,
    listTables,
    close,
  };
}
