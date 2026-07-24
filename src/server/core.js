// The safety core. Framework-agnostic handlers: each takes the sqlite handle
// plus already-parsed inputs and returns a plain { status, body } object. The
// HTTP layer (server.js) maps requests onto these; keeping them pure means the
// safety logic can be unit-tested without a server or an auth stack.
//
// SAFETY MODEL - read src/server/sqlite.js first. The permission boundary is the
// CONNECTION, not the classification below. A read statement runs on the
// readonly handle, so SQLite rejects any write that slips past the sniffer. The
// sniffer here is UX only: a friendly error + choosing read-vs-write intent.

// Hard cap so a runaway query can't flood the browser.
export const MAX_ROWS = 1000;

// ---- statement classification (UX only - see the safety note above) --------

// Strip comments and leading whitespace so the first keyword is findable.
export function stripLeading(sql) {
  let s = String(sql ?? "");
  for (;;) {
    const t = s.replace(/^\s+/, "");
    if (t.startsWith("--")) { s = t.replace(/^--[^\n]*\n?/, ""); continue; }
    if (t.startsWith("/*")) { s = t.replace(/^\/\*[\s\S]*?\*\//, ""); continue; }
    return t;
  }
}

const READ_STARTERS =
  /^(select|with|explain|pragma\s+table_info|pragma\s+index_list|pragma\s+index_info|pragma\s+foreign_key_list)\b/i;

export function looksReadOnly(sql) {
  return READ_STARTERS.test(stripLeading(sql));
}

// One statement per run. Trailing semicolon is fine; a second statement is not.
// (bun:sqlite's query() would only run the first anyway - better to say so.)
export function splitCount(sql) {
  let n = 0, inS = false, inD = false, inLine = false, inBlock = false;
  const s = String(sql ?? "");
  for (let i = 0; i < s.length; i++) {
    const ch = s[i], next = s[i + 1];
    if (inLine)  { if (ch === "\n") inLine = false; continue; }
    if (inBlock) { if (ch === "*" && next === "/") { inBlock = false; i++; } continue; }
    if (inS) { if (ch === "'") inS = false; continue; }
    if (inD) { if (ch === '"') inD = false; continue; }
    if (ch === "-" && next === "-") { inLine = true; i++; continue; }
    if (ch === "/" && next === "*") { inBlock = true; i++; continue; }
    if (ch === "'") { inS = true; continue; }
    if (ch === '"') { inD = true; continue; }
    if (ch === ";" && s.slice(i + 1).trim()) n++;   // ; with real SQL after it
  }
  return n + 1;
}

export function rejectMultiple(sql) {
  return splitCount(sql) > 1
    ? "One statement per run. Use a separate tab for each statement."
    : null;
}

// ---- GET /tables ----
export function handleTables(sqlite) {
  return { status: 200, body: { tables: sqlite.listTables() } };
}

// ---- GET /schema/:table ----
export function handleSchema(sqlite, name) {
  const ro = sqlite.readonlyDb();
  const meta = ro
    .query(`SELECT name, type, sql FROM sqlite_master WHERE name = $n AND type IN ('table','view')`)
    .get({ $n: name });
  if (!meta) return { status: 404, body: { error: "not found" } };
  const q = name.replace(/"/g, '""');
  const columns = ro.query(`PRAGMA table_info("${q}")`).all();
  const indexes = ro.query(`PRAGMA index_list("${q}")`).all();
  const foreignKeys = ro.query(`PRAGMA foreign_key_list("${q}")`).all();
  return {
    status: 200,
    body: { name: meta.name, type: meta.type, ddl: meta.sql, columns, indexes, foreignKeys },
  };
}

// ---- POST /check ----  parse only; never executes.
export function handleCheck(sqlite, sql) {
  const multi = rejectMultiple(sql);
  if (multi) return { status: 200, body: { ok: false, error: multi } };
  try {
    // Preparing compiles + validates without running. Done on the readonly
    // handle so even preparing can't have a side effect.
    sqlite.readonlyDb().query(String(sql ?? "")).finalize();
    return { status: 200, body: { ok: true, readOnly: looksReadOnly(sql) } };
  } catch (e) {
    return { status: 200, body: { ok: false, error: e.message } };
  }
}

// ---- POST /run ----  execute ONE statement.
// { sql, commit?, canWrite } - commit only meaningful on the write path (Slice 4).
export function handleRun(sqlite, { sql, commit = false, canWrite = false } = {}) {
  const text = String(sql ?? "").trim();
  if (!text) return { status: 400, body: { error: "no SQL supplied" } };

  const multi = rejectMultiple(text);
  if (multi) return { status: 400, body: { error: multi } };

  const started = Date.now();

  // ---- read path: readonly connection, SQLite enforces it ----
  // A statement crafted to LOOK read-only (leading CTE) also lands here, and the
  // readonly handle refuses it - that rejection IS the product.
  if (looksReadOnly(text)) {
    try {
      const rows = sqlite.readonlyDb().query(text).all();
      const capped = rows.length > MAX_ROWS;
      return {
        status: 200,
        body: {
          mode: "read",
          columns: rows.length ? Object.keys(rows[0]) : [],
          rows: capped ? rows.slice(0, MAX_ROWS) : rows,
          rowCount: rows.length,
          capped,
          maxRows: MAX_ROWS,
          ms: Date.now() - started,
        },
      };
    } catch (e) {
      return { status: 400, body: { error: e.message } };
    }
  }

  // ---- write path ----
  if (!canWrite) {
    return {
      status: 403,
      body: {
        error: "This looks like a write statement and your access is read-only.",
        code: "read_only",
      },
    };
  }

  // Transactions, dry-run/commit, snapshots and audit land in Slice 4.
  return {
    status: 501,
    body: { error: "The write path is not enabled in this build.", code: "write_not_implemented" },
  };
}
