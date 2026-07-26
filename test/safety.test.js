// The safety tests. Ported from a reference implementation and rewritten to
// exercise the standalone core handlers directly - no HTTP, no
// auth stack. These are the definition of done for the core: the read-only
// CONNECTION is the boundary, and the disguised-write-rejected test proves the
// sniffer is not what's protecting the database.
//
// Slice 2 covers the read path. The rollback + snapshot tests arrive with the
// write path in Slice 4.

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSqlite } from "../src/server/sqlite.js";
import { openSidecar, sidecarPath } from "../src/server/sidecar.js";
import { existsSync } from "node:fs";
import {
  handleTables,
  handleSchema,
  handleCheck,
  handleRun,
  handleListSnippets,
  handleCreateSnippet,
  handleUpdateSnippet,
  handleDeleteSnippet,
  MAX_ROWS,
  looksReadOnly,
  splitCount,
} from "../src/server/core.js";

let dir, dbPath, reader;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "sqlite-wb-"));
  dbPath = join(dir, "test.sqlite");

  // Seed with a throwaway writable handle we control (the tool's own reader
  // never writes). WAL so it matches how the tool expects to be pointed.
  const seed = new Database(dbPath);
  seed.exec("PRAGMA journal_mode = WAL");
  seed.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, email TEXT)`);
  seed.exec(`INSERT INTO users (name, email) VALUES ('alice','a@x'), ('bob','b@x')`);
  seed.exec(`CREATE VIEW recent AS SELECT * FROM users ORDER BY id DESC`);
  // > MAX_ROWS rows to exercise the cap.
  seed.exec(`CREATE TABLE big (n INTEGER PRIMARY KEY)`);
  seed.exec(`
    INSERT INTO big (n)
    WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < ${MAX_ROWS + 1})
    SELECT n FROM seq
  `);
  seed.close();

  // The tool's read-only view of that database (write disabled).
  reader = openSqlite({ dbPath, write: false });
});

afterAll(() => {
  reader?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("statement classification (UX only)", () => {
  it("recognises read starters incl. leading CTE, and counts statements", () => {
    expect(looksReadOnly("SELECT 1")).toBe(true);
    expect(looksReadOnly("  with x as (select 1) select * from x")).toBe(true);
    expect(looksReadOnly("DELETE FROM users")).toBe(false);
    expect(splitCount("SELECT 1")).toBe(1);
    expect(splitCount("SELECT 1;")).toBe(1);          // trailing ; is one statement
    expect(splitCount("SELECT 1; SELECT 2")).toBe(2);
    expect(splitCount("SELECT ';'")).toBe(1);          // ; inside a string doesn't count
  });
});

describe("read path", () => {
  it("lists tables/views with row counts and returns a table's schema", () => {
    const { body } = handleTables(reader);
    expect(body.tables.some((t) => t.name === "users" && t.type === "table" && t.rows === 2)).toBe(true);
    expect(body.tables.some((t) => t.name === "recent" && t.type === "view")).toBe(true);

    const schema = handleSchema(reader, "users");
    expect(schema.status).toBe(200);
    expect(schema.body.name).toBe("users");
    expect(schema.body.columns.some((c) => c.name === "email")).toBe(true);
    expect(schema.body.ddl).toContain("CREATE TABLE");

    expect(handleSchema(reader, "no_such_table").status).toBe(404);
  });

  it("runs a SELECT and reports columns + timing", () => {
    const { status, body } = handleRun(reader, { sql: "SELECT 1 AS a, 'x' AS b" });
    expect(status).toBe(200);
    expect(body.mode).toBe("read");
    expect(body.columns).toEqual(["a", "b"]);
    expect(body.rows[0]).toEqual({ a: 1, b: "x" });
    expect(typeof body.ms).toBe("number");
  });

  it("caps results at MAX_ROWS but reports the true rowCount", () => {
    const { body } = handleRun(reader, { sql: "SELECT * FROM big" });
    expect(body.rowCount).toBe(MAX_ROWS + 1);
    expect(body.rows.length).toBe(MAX_ROWS);
    expect(body.capped).toBe(true);
    expect(body.maxRows).toBe(MAX_ROWS);
  });

  it("rejects more than one statement per run; a trailing semicolon is fine", () => {
    const multi = handleRun(reader, { sql: "SELECT 1; SELECT 2" });
    expect(multi.status).toBe(400);
    expect(multi.body.error).toContain("One statement per run");
    expect(handleRun(reader, { sql: "SELECT 1;" }).status).toBe(200);
  });

  it("check validates without executing", () => {
    expect(handleCheck(reader, "SELECT 1").body.ok).toBe(true);
    const bad = handleCheck(reader, "SELECT * FROM nope_xyz").body;
    expect(bad.ok).toBe(false);
    expect(bad.error).toContain("no such table");
  });
});

describe("READ-ONLY IS ENFORCED BY THE CONNECTION, not the sniffer", () => {
  it("(a) an obvious write from a read-only user gets a friendly 403", () => {
    const res = handleRun(reader, { sql: "DELETE FROM users WHERE id = -1", canWrite: false });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("read_only");
  });

  it("(b) a write disguised as read-only (leading CTE) slips the sniffer - and SQLite still refuses it", () => {
    // looksReadOnly() is fooled on purpose here...
    expect(looksReadOnly("WITH x AS (SELECT 1) DELETE FROM users WHERE id = -1")).toBe(true);
    // ...so the statement reaches the readonly CONNECTION, which rejects it.
    const res = handleRun(reader, {
      sql: "WITH x AS (SELECT 1) DELETE FROM users WHERE id = -1",
      canWrite: false,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/readonly database/i);

    // Belt and braces: the raw readonly handle refuses it too, proving the
    // guarantee is the connection itself and not anything in the handler.
    expect(() => reader.readonlyDb().query("WITH x AS (SELECT 1) DELETE FROM users").run()).toThrow(
      /readonly database/i
    );
  });

  it("a write can't be executed when the process is read-only, even if policy allows it", () => {
    expect(() => reader.writeDb()).toThrow(/write access is disabled/i);
    // A read-only process has no write handle at all, so even a canWrite:true
    // request is refused - defence in depth behind the connection boundary.
    const res = handleRun(reader, { sql: "INSERT INTO users (name) VALUES ('z')", canWrite: true });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("read_only");
    expect(handleRun(reader, { sql: "SELECT COUNT(*) AS n FROM users WHERE name='z'" }).body.rows[0].n).toBe(0);
  });
});

// A fresh writable database per test - no cross-test coupling on row counts or
// the snapshot directory.
function makeWriter() {
  const dir = mkdtempSync(join(tmpdir(), "sqlite-wb-w-"));
  const path = join(dir, "w.sqlite");
  const seed = new Database(path);
  seed.exec("PRAGMA journal_mode = WAL");
  seed.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
  seed.close();
  const w = openSqlite({ dbPath: path, write: true });
  return { w, path, cleanup() { w.close(); rmSync(dir, { recursive: true, force: true }); } };
}

describe("write path (--write): rolls back unless committed", () => {
  it("a write rolls back by default and only persists when committed; audit records both", () => {
    const { w, cleanup } = makeWriter();
    const audits = [];
    const on = (e) => audits.push(e);
    try {
      // no commit -> reported but rolled back
      const dry = handleRun(w, { sql: "INSERT INTO t (v) VALUES ('dry')", canWrite: true, onExecute: on });
      expect(dry.status).toBe(200);
      expect(dry.body.mode).toBe("write");
      expect(dry.body.committed).toBe(false);
      expect(dry.body.rowsAffected).toBe(1);
      expect(dry.body.snapshot).toBe(null);        // dry runs are not snapshotted
      expect(handleRun(w, { sql: "SELECT COUNT(*) AS n FROM t" }).body.rows[0].n).toBe(0);

      // commit -> persists
      const wet = handleRun(w, { sql: "INSERT INTO t (v) VALUES ('wet')", canWrite: true, commit: true, onExecute: on });
      expect(wet.body.committed).toBe(true);
      expect(wet.body.rowsAffected).toBe(1);
      expect(handleRun(w, { sql: "SELECT COUNT(*) AS n FROM t" }).body.rows[0].n).toBe(1);

      // both executions were audited, flagged correctly
      expect(audits.length).toBe(2);
      expect(audits[0].committed).toBe(false);
      expect(audits[1].committed).toBe(true);
      expect(audits[1].snapshot).toBeTruthy();
    } finally { cleanup(); }
  });

  it("snapshots before a COMMITTED write only, capturing the pre-write state", () => {
    const { w, path, cleanup } = makeWriter();
    const snaps = () => {
      try { return readdirSync(w.snapshotDir).filter((f) => f.startsWith("before-")); }
      catch { return []; }
    };
    try {
      handleRun(w, { sql: "INSERT INTO t (v) VALUES ('one')", canWrite: true, commit: true });

      // a dry run changes nothing, so there's nothing to snapshot
      const before = snaps().length;
      handleRun(w, { sql: "INSERT INTO t (v) VALUES ('dry')", canWrite: true });
      expect(snaps().length).toBe(before);

      // a committed write snapshots first - the file must show the state BEFORE it
      const wet = handleRun(w, { sql: "INSERT INTO t (v) VALUES ('two')", canWrite: true, commit: true });
      expect(wet.body.snapshot).toBeTruthy();

      const liveRows = new Database(path, { readonly: true }).query("SELECT COUNT(*) AS n FROM t").get().n;
      const snapRows = new Database(join(w.snapshotDir, wet.body.snapshot), { readonly: true })
        .query("SELECT COUNT(*) AS n FROM t").get().n;
      expect(liveRows).toBe(2);   // 'one' + 'two'
      expect(snapRows).toBe(1);   // 'two' isn't in the pre-write snapshot
    } finally { cleanup(); }
  });

  it("a disguised write is refused even on a writable process unless the user may write", () => {
    const { w, cleanup } = makeWriter();
    try {
      // read-only user (canWrite:false) hitting a writable process: the leading-CTE
      // write looks read-only, reaches the readonly connection, and is refused.
      const res = handleRun(w, { sql: "WITH x AS (SELECT 1) DELETE FROM t", canWrite: false });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/readonly database/i);
    } finally { cleanup(); }
  });
});

describe("snippets (sidecar store)", () => {
  let sdir, target, store;
  beforeAll(() => {
    sdir = mkdtempSync(join(tmpdir(), "sqlite-wb-s-"));
    target = join(sdir, "app.sqlite");
    // Seed a target DB (its schema must stay untouched by snippet storage).
    const seed = new Database(target);
    seed.exec("PRAGMA journal_mode = WAL");
    seed.exec("CREATE TABLE app_table (id INTEGER PRIMARY KEY)");
    seed.close();
    store = openSidecar(target);
  });
  afterAll(() => { store?.close(); rmSync(sdir, { recursive: true, force: true }); });

  it("creates, lists, updates and deletes; requires name and sql", () => {
    // create
    const created = handleCreateSnippet(store, { name: "recent", sql: "SELECT 1", who: "alice" });
    expect(created.status).toBe(201);
    const snip = created.body.snippet;
    expect(snip.name).toBe("recent");
    expect(snip.owner).toBe("alice");

    // list (shared)
    const list = handleListSnippets(store).body.snippets;
    expect(list.some((s) => s.id === snip.id)).toBe(true);

    // update by the owner
    const upd = handleUpdateSnippet(store, snip.id, { name: "renamed" }, { who: "alice" });
    expect(upd.status).toBe(200);
    expect(upd.body.snippet.name).toBe("renamed");
    expect(upd.body.snippet.sql).toBe("SELECT 1"); // unchanged fields kept

    // name + sql are required
    expect(handleCreateSnippet(store, { name: "x", who: "alice" }).status).toBe(400);

    // delete
    expect(handleDeleteSnippet(store, snip.id, { who: "alice" }).status).toBe(200);
    expect(handleDeleteSnippet(store, snip.id, { who: "alice" }).status).toBe(404);
  });

  it("only the owner or an admin may change/delete a snippet", () => {
    const snip = handleCreateSnippet(store, { name: "mine", sql: "SELECT 2", who: "alice" }).body.snippet;

    // another user cannot change or delete it
    expect(handleUpdateSnippet(store, snip.id, { name: "hijack" }, { who: "bob" }).status).toBe(403);
    expect(handleDeleteSnippet(store, snip.id, { who: "bob" }).status).toBe(403);

    // an admin can override
    expect(handleDeleteSnippet(store, snip.id, { who: "bob", isAdmin: true }).status).toBe(200);
  });

  it("stores snippets in the sidecar file, NOT the target schema", () => {
    handleCreateSnippet(store, { name: "keep", sql: "SELECT 3", who: null });

    // the sidecar file exists and holds the snippet...
    expect(existsSync(sidecarPath(target))).toBe(true);

    // ...and the target DB's schema is untouched (no snippets/sql_snippets table)
    const t = new Database(target, { readonly: true });
    const names = t.query(`SELECT name FROM sqlite_master WHERE type='table'`).all().map((r) => r.name);
    t.close();
    expect(names).toContain("app_table");
    expect(names).not.toContain("snippets");
    expect(names).not.toContain("sql_snippets");
  });
});
