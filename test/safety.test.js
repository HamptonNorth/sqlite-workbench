// The safety tests. Ported from the reference (aph2-diary tests/tier2/sql.test.js)
// and rewritten to exercise the standalone core handlers directly - no HTTP, no
// auth stack. These are the definition of done for the core: the read-only
// CONNECTION is the boundary, and the disguised-write-rejected test proves the
// sniffer is not what's protecting the database.
//
// Slice 2 covers the read path. The rollback + snapshot tests arrive with the
// write path in Slice 4.

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSqlite } from "../src/server/sqlite.js";
import {
  handleTables,
  handleSchema,
  handleCheck,
  handleRun,
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

  it("even 'canWrite' can't be opened when the process is read-only", () => {
    expect(() => reader.writeDb()).toThrow(/write access is disabled/i);
    // and the write path is not wired in this slice
    const res = handleRun(reader, { sql: "INSERT INTO users (name) VALUES ('z')", canWrite: true });
    expect(res.status).toBe(501);
    expect(res.body.code).toBe("write_not_implemented");
  });
});
