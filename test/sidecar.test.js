// Sidecar location, legacy migration, and the opt-in tab-state store.

import { test, expect } from "bun:test";
import { mkdtempSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, basename } from "node:path";
import { Database } from "bun:sqlite";
import { openSidecar, sidecarPath, legacySidecarPath, migrateLegacySidecar } from "../src/server/sidecar.js";

const newDb = () => {
  const dir = mkdtempSync(join(tmpdir(), "wb-"));
  const db = join(dir, "app.db");
  new Database(db).close();
  return db;
};

test("the sidecar sits outside the database's own filename glob", () => {
  const db = newDb();
  const side = sidecarPath(db);

  // The whole point: `rm <db>*` must not match the sidecar. That glob is the
  // natural way to force a clean rebuild, and it used to take snippets with it.
  expect(side.startsWith(db)).toBe(false);
  expect(basename(side)).toBe("app.db.sqlite");
  expect(dirname(side)).toBe(join(dirname(db), ".workbench"));
});

test("a sidecar at the legacy path is migrated, WAL and all", () => {
  const db = newDb();
  const legacy = legacySidecarPath(db);

  const old = new Database(legacy);
  old.exec(`CREATE TABLE snippets (id INTEGER PRIMARY KEY, name TEXT NOT NULL, sql TEXT NOT NULL,
    owner TEXT, created TEXT DEFAULT (CURRENT_TIMESTAMP), updated TEXT DEFAULT (CURRENT_TIMESTAMP))`);
  old.query("INSERT INTO snippets (name, sql) VALUES ('keeper', 'SELECT 1')").run();
  old.close();
  writeFileSync(legacy + "-wal", "");

  expect(migrateLegacySidecar(db)).toBe(legacy);
  expect(existsSync(legacy)).toBe(false);
  expect(existsSync(sidecarPath(db))).toBe(true);
  expect(existsSync(sidecarPath(db) + "-wal")).toBe(true);

  const store = openSidecar(db);
  expect(store.listSnippets().map((s) => s.name)).toEqual(["keeper"]);
  store.close();
});

test("migration never clobbers an existing sidecar", () => {
  const db = newDb();
  writeFileSync(legacySidecarPath(db), "");

  const store = openSidecar(db);          // creates the new-path sidecar
  store.createSnippet({ name: "live", sql: "SELECT 2" });
  store.close();

  expect(migrateLegacySidecar(db)).toBe(null);
  expect(existsSync(legacySidecarPath(db))).toBe(true);

  const after = openSidecar(db);
  expect(after.listSnippets().map((s) => s.name)).toEqual(["live"]);
  after.close();
});

test("tab state round-trips and clears", () => {
  const db = newDb();
  const store = openSidecar(db);

  expect(store.getUiState("tabs")).toBe(null);
  store.setUiState("tabs", JSON.stringify({ tabs: [{ id: 1, name: "Query 1" }], active: 1 }));
  expect(JSON.parse(store.getUiState("tabs")).tabs[0].name).toBe("Query 1");

  store.setUiState("tabs", JSON.stringify({ tabs: [{ id: 2 }], active: 2 })); // upsert, not duplicate
  expect(JSON.parse(store.getUiState("tabs")).active).toBe(2);

  store.clearUiState("tabs");
  expect(store.getUiState("tabs")).toBe(null);
  store.close();
});

test("reading tab state does not create a sidecar file", () => {
  // A read-only browse that saves nothing must leave no trace on disk.
  const db = newDb();
  const store = openSidecar(db);
  expect(store.getUiState("tabs")).toBe(null);
  expect(existsSync(sidecarPath(db))).toBe(false);
  store.close();
});
