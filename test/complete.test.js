// Editor autocomplete: the alias reader and the caret context. Pure logic, so
// these run without a DOM.

import { describe, it, expect } from "bun:test";
import {
  completionsFor,
  completionContext,
  parseTableRefs,
  unquoteIdent,
  MAX_ITEMS,
} from "../src/client/complete.js";

const schema = {
  products: ["id", "name", "price", "product_group_id"],
  product_group: ["id", "title", "note"],
  orders: ["id", "product_id", "qty"],
};

// Caret is wherever the | marker is; returns { sql, caret }.
function at(marked) {
  const caret = marked.indexOf("|");
  return { sql: marked.replace("|", ""), caret };
}

describe("identifier quoting", () => {
  it("unwraps the three SQLite quoting styles", () => {
    expect(unquoteIdent('"users"')).toBe("users");
    expect(unquoteIdent("[users]")).toBe("users");
    expect(unquoteIdent("`users`")).toBe("users");
    expect(unquoteIdent("users")).toBe("users");
  });
});

describe("parseTableRefs", () => {
  it("maps aliases with and without AS, and plain table names", () => {
    const { aliases, tables } = parseTableRefs("SELECT * FROM products AS p, product_group pg");
    expect(tables).toEqual(["products", "product_group"]);
    expect(aliases.get("p")).toBe("products");
    expect(aliases.get("pg")).toBe("product_group");
    expect(aliases.get("products")).toBe("products");   // the name itself resolves
  });

  it("reads JOINs and stops at ON / WHERE", () => {
    const { aliases, tables } = parseTableRefs(
      "SELECT * FROM orders o JOIN products AS p ON p.id = o.product_id WHERE o.qty > 1"
    );
    expect(tables).toEqual(["orders", "products"]);
    expect(aliases.get("o")).toBe("orders");
    expect(aliases.get("p")).toBe("products");
  });

  it("ignores subqueries rather than guessing", () => {
    const { tables } = parseTableRefs("SELECT * FROM (SELECT 1) AS x");
    expect(tables).toEqual([]);
  });
});

describe("completionContext", () => {
  it("recognises a qualifier with an empty prefix", () => {
    expect(completionContext("SELECT p.")).toEqual({ kind: "qualified", qualifier: "p", prefix: "" });
    expect(completionContext("SELECT p.na")).toEqual({ kind: "qualified", qualifier: "p", prefix: "na" });
  });

  it("recognises a bare word", () => {
    expect(completionContext("SELECT pri")).toEqual({ kind: "bare", prefix: "pri" });
  });

  it("stays quiet inside a string literal", () => {
    expect(completionContext("SELECT * FROM t WHERE name = 'p.")).toBe(null);
    // ...but a closed string is fine
    expect(completionContext("SELECT * FROM t WHERE name = 'x' AND p.")).not.toBe(null);
  });
});

describe("completionsFor", () => {
  it("offers the aliased table's columns for `p.` — the multi-line case", () => {
    // The example from the brief: the FROM clause is BELOW the caret.
    const { sql, caret } = at("SELECT p.|\nFROM products AS p, product_group AS pg");
    const r = completionsFor({ sql, caret, schema });
    expect(r.items.map((i) => i.value)).toEqual(["id", "name", "price", "product_group_id"]);
    expect(r.items[0].detail).toBe("products");
    expect(r.prefix).toBe("");
  });

  it("filters those columns by what's typed", () => {
    const { sql, caret } = at("SELECT p.pr|\nFROM products AS p, product_group AS pg");
    const r = completionsFor({ sql, caret, schema });
    expect(r.items.map((i) => i.value)).toEqual(["price", "product_group_id"]);
    expect(r.prefix).toBe("pr");
  });

  it("resolves the second alias independently", () => {
    const { sql, caret } = at("SELECT pg.|\nFROM products AS p, product_group AS pg");
    const r = completionsFor({ sql, caret, schema });
    expect(r.items.map((i) => i.value)).toEqual(["id", "title", "note"]);
  });

  it("resolves a table named in full, with no alias", () => {
    const { sql, caret } = at("SELECT orders.q| FROM orders");
    const r = completionsFor({ sql, caret, schema });
    expect(r.items.map((i) => i.value)).toEqual(["qty"]);
  });

  it("says nothing for an unknown qualifier", () => {
    const { sql, caret } = at("SELECT zz.| FROM products AS p");
    expect(completionsFor({ sql, caret, schema })).toBe(null);
  });

  it("offers in-scope columns and table names for a bare prefix", () => {
    const { sql, caret } = at("SELECT pri| FROM products AS p");
    const r = completionsFor({ sql, caret, schema });
    const vals = r.items.map((i) => i.value);
    expect(vals).toContain("price");                       // column of an in-scope table
    const bare = completionsFor({ ...at("SELECT * FROM prod|"), schema });
    expect(bare.items.map((i) => i.value)).toContain("products");   // table name
    expect(bare.items.map((i) => i.value)).toContain("product_group");
  });

  it("stays quiet on an empty bare prefix unless explicitly asked", () => {
    const { sql, caret } = at("SELECT | FROM products");
    expect(completionsFor({ sql, caret, schema })).toBe(null);
    expect(completionsFor({ sql, caret, schema, force: true })).not.toBe(null);
  });

  it("caps the list", () => {
    const wide = {};
    wide.big = Array.from({ length: 50 }, (_, i) => `col_${i}`);
    const { sql, caret } = at("SELECT b.| FROM big b");
    expect(completionsFor({ sql, caret, schema: wide }).items.length).toBe(MAX_ITEMS);
  });
});
