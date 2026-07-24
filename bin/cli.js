#!/usr/bin/env bun
// sqlite-workbench <db.sqlite> [options]
//
// Points the workbench at a SQLite file and serves a browser SQL workbench next
// to it. Read-only by default; --write opts in to editing (with guard rails).

import { parseArgs } from "node:util";
import { statSync, accessSync, constants } from "node:fs";
import { resolve, basename } from "node:path";
import { openSqlite } from "../src/server/sqlite.js";
import { openSidecar } from "../src/server/sidecar.js";
import { startServer } from "../src/server/server.js";

const USAGE = `sqlite-workbench <db.sqlite> [options]

  <db.sqlite>          path to the SQLite database file (required)

Options:
  --write              enable editing (default: read-only)
  --port <n>           port to listen on (default: 9999)
  --host <addr>        address to bind (default: 127.0.0.1; use 0.0.0.0 to expose)
  --base <path>        API base path (default: /api)
  --set-wal            switch the DB to WAL journal mode (explicit opt-in)
  --snippets-in-db     store saved snippets in the target DB instead of a sidecar
  -h, --help           show this help

Examples:
  sqlite-workbench ./app.db
  sqlite-workbench ./app.db --write
  sqlite-workbench ./app.db --port 8080 --host 127.0.0.1
`;

function die(msg, code = 1) {
  console.error(msg);
  process.exit(code);
}

let parsed;
try {
  parsed = parseArgs({
    allowPositionals: true,
    options: {
      write: { type: "boolean", default: false },
      port: { type: "string" },
      host: { type: "string" },
      base: { type: "string" },
      "set-wal": { type: "boolean", default: false },
      "snippets-in-db": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
} catch (e) {
  die(`${e.message}\n\n${USAGE}`);
}

const { values, positionals } = parsed;

if (values.help) {
  console.log(USAGE);
  process.exit(0);
}

if (positionals.length === 0) die(`error: no database file given\n\n${USAGE}`);
if (positionals.length > 1) die(`error: expected one database file, got ${positionals.length}\n\n${USAGE}`);

const dbPath = resolve(positionals[0]);

// Fail early and clearly if the file can't be used.
try {
  const st = statSync(dbPath);
  if (!st.isFile()) die(`error: not a file: ${dbPath}`);
} catch {
  die(`error: database file not found: ${dbPath}`);
}
try {
  // The workbench must READ and WRITE the file (snapshots, WAL, edits), so check
  // for both even in read-only mode - a read-only DB can't be snapshotted safely.
  accessSync(dbPath, constants.R_OK);
} catch {
  die(`error: cannot read database file (check permissions): ${dbPath}`);
}

const port = values.port ? Number(values.port) : 9999;
if (!Number.isInteger(port) || port < 1 || port > 65535) die(`error: invalid --port: ${values.port}`);
const host = values.host || "127.0.0.1";
const base = values.base || "/api";

let sqlite;
try {
  sqlite = openSqlite({
    dbPath,
    write: values.write,
    setWal: values["set-wal"],
  });
} catch (e) {
  die(`error: could not open database: ${e.message}`);
}

// Audit trail and saved snippets live in the sidecar file
// (<db>.workbench.sqlite), never in the target schema unless --snippets-in-db is
// given. Lazy: no sidecar file appears until the first thing needs recording.
const sidecar = openSidecar(dbPath, { snippetsInDb: values["snippets-in-db"] });
const server = startServer({
  sqlite, host, port, base,
  onExecute: sidecar.appendAudit,
  store: sidecar,
});

// ---- friendly startup banner ----
let tableCount = null;
try { tableCount = sqlite.listTables().length; } catch { /* leave unknown */ }

const dbName = basename(dbPath);
const tablesNote = tableCount == null ? "" : `  (${tableCount} ${tableCount === 1 ? "table" : "tables"})`;
const mode = values.write ? "read / write  (editing enabled)" : "read-only  (use --write to enable editing)";
// 0.0.0.0 isn't clickable/browsable; point the user at localhost but flag it.
const browseHost = host === "0.0.0.0" ? "localhost" : host;
const url = `http://${browseHost}:${server.port}`;

console.log("");
console.log(`  sqlite-workbench`);
console.log("");
console.log(`  ✓ Connected to ${dbName}${tablesNote}`);
console.log(`    ${dbPath}`);
console.log("");
console.log(`  Mode   ${mode}`);
console.log(`  Open   ${url}   ← open this in your browser`);
if (host === "0.0.0.0") {
  console.log(`  Note   ⚠ exposed on ALL interfaces (0.0.0.0) — reachable from other machines`);
}
if (!sqlite.isWal) {
  console.log("");
  console.log(`  ⚠ Journal mode is "${sqlite.journalMode || "unknown"}", not WAL. As a second process`);
  console.log(`    writing this file, concurrent access with the host app will be contentious.`);
  console.log(`    Re-run with --set-wal to switch (persistent, explicit opt-in).`);
}
console.log("");
console.log(`  Press Ctrl+C to stop.`);
console.log("");

function shutdown() {
  try { server.stop(); } catch { /* ignore */ }
  try { sqlite.close(); } catch { /* ignore */ }
  try { sidecar.close(); } catch { /* ignore */ }
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
