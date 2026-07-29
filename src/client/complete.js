// Schema-aware completion for the SQL editor. Pure functions, no DOM - the
// popup that renders these lives in workbench.js, and these are unit-tested
// directly (test/complete.test.js).
//
// The useful case: given
//
//     SELECT |
//     FROM products AS p, product_group AS pg
//
// typing `p.` should offer the columns of `products`. That needs two things:
// the table each alias refers to (parseTableRefs) and what the caret is
// currently touching (completionContext).
//
// This is a deliberately small, regex-based reader, NOT a SQL parser. It reads
// only the FROM/JOIN clauses well enough to map aliases, and gives up quietly
// (no suggestions) on anything it doesn't understand - a wrong suggestion is
// worse than none.

// Longest sensible list to put in front of someone; more than this and you
// should be typing, not scrolling.
export const MAX_ITEMS = 12;

// Clause keywords that end a table list. Table refs live between FROM/JOIN and
// one of these, so they mark where to stop reading.
// Both word boundaries matter: without the trailing one, `order` matches inside
// `orders` and the table list is cut off at its own first table.
const CLAUSE_END =
  /\b(?:where|group|order|having|limit|offset|window|union|intersect|except|on|using|join|inner|left|right|full|cross|natural|set|values|returning)\b/i;

/** `"users"`, `[users]`, `` `users` `` -> users */
export function unquoteIdent(s) {
  const t = String(s ?? "").trim();
  if (t.length >= 2) {
    const a = t[0], b = t[t.length - 1];
    if ((a === '"' && b === '"') || (a === "`" && b === "`") || (a === "[" && b === "]")) {
      return t.slice(1, -1);
    }
  }
  return t;
}

/**
 * Read the FROM/JOIN clauses.
 * @returns {{aliases: Map<string,string>, tables: string[]}}
 *   aliases maps a lowercased alias OR table name to the real table name;
 *   tables lists the real tables in scope, in the order written.
 */
export function parseTableRefs(sql) {
  const aliases = new Map();
  const tables = [];
  const text = String(sql ?? "");
  const re = /\b(?:from|join)\s+/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    let rest = text.slice(m.index + m[0].length);
    // Stop at the next clause keyword; what's left is the table list.
    const end = rest.search(CLAUSE_END);
    if (end !== -1) rest = rest.slice(0, end);

    for (const part of rest.split(",")) {
      const t = part.trim();
      // Subqueries and table-valued functions aren't resolvable here - skip.
      if (!t || t.startsWith("(") || t.includes("(")) continue;
      const bits = t.split(/\s+/).filter(Boolean);
      const name = unquoteIdent(bits[0]);
      if (!name) continue;

      let alias = null;
      if (bits.length >= 3 && /^as$/i.test(bits[1])) alias = unquoteIdent(bits[2]);
      else if (bits.length === 2) alias = unquoteIdent(bits[1]);

      if (!tables.includes(name)) tables.push(name);
      aliases.set(name.toLowerCase(), name);
      if (alias) aliases.set(alias.toLowerCase(), name);
    }
  }
  return { aliases, tables };
}

// An odd number of unescaped single quotes before the caret means we're inside a
// string literal, where a column name is never what you want.
function insideString(before) {
  let open = false;
  for (let i = 0; i < before.length; i++) {
    if (before[i] !== "'") continue;
    if (open && before[i + 1] === "'") { i++; continue; }  // '' escape
    open = !open;
  }
  return open;
}

/**
 * What is the caret touching?
 * @returns {{kind: "qualified"|"bare", qualifier?: string, prefix: string} | null}
 */
export function completionContext(before) {
  if (insideString(before)) return null;
  // alias.prefix  (prefix may be empty - that's the `p.` case)
  const q = /(?:^|[^\w.$])([\w"`\][]+)\.(\w*)$/.exec(before);
  if (q) return { kind: "qualified", qualifier: unquoteIdent(q[1]), prefix: q[2] };
  // a bare word, but never straight after a dot we failed to parse
  const b = /(?:^|[^\w.$])(\w*)$/.exec(before);
  if (b) return { kind: "bare", prefix: b[1] };
  return null;
}

// Resolve a qualifier to a real table: an alias, or a table named directly
// (case-insensitively, since SQLite identifiers are case-insensitive).
function resolveTable(qualifier, aliases, schema) {
  const key = qualifier.toLowerCase();
  if (aliases.has(key)) return aliases.get(key);
  for (const name of Object.keys(schema)) {
    if (name.toLowerCase() === key) return name;
  }
  return null;
}

/**
 * Completions for the caret position.
 * @param {object} o
 * @param {string} o.sql     full editor contents
 * @param {number} o.caret   caret offset
 * @param {Record<string,string[]>} o.schema  table -> column names
 * @param {boolean} [o.force] explicit request (Ctrl+Space): suggest even with
 *   no prefix typed, where typing-as-you-go would stay quiet.
 * @returns {{items: {value:string, detail:string, kind:string}[], prefix: string} | null}
 */
export function completionsFor({ sql, caret, schema = {}, force = false } = {}) {
  const before = String(sql ?? "").slice(0, caret);
  const ctx = completionContext(before);
  if (!ctx) return null;

  const { aliases, tables: inScope } = parseTableRefs(sql);
  const prefix = ctx.prefix.toLowerCase();
  let items = [];

  if (ctx.kind === "qualified") {
    const table = resolveTable(ctx.qualifier, aliases, schema);
    if (!table || !schema[table]) return null;
    // Schema order, not alphabetical: the natural column order of a table is
    // more recognisable than an alphabetised one.
    items = schema[table].map((c) => ({ value: c, detail: table, kind: "column" }));
  } else {
    // Typing-as-you-go needs at least a letter, or every keystroke pops a menu.
    if (!force && ctx.prefix.length < 1) return null;
    const cols = [];
    for (const t of inScope) {
      for (const c of schema[t] ?? []) cols.push({ value: c, detail: t, kind: "column" });
    }
    const tbls = Object.keys(schema)
      .sort()
      .map((t) => ({ value: t, detail: "table", kind: "table" }));
    // Columns of tables you've already named beat the full table list.
    items = [...cols.sort((a, b) => a.value.localeCompare(b.value)), ...tbls];
  }

  const seen = new Set();
  items = items.filter((i) => {
    if (!i.value.toLowerCase().startsWith(prefix)) return false;
    const key = `${i.kind}:${i.detail}:${i.value}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  if (!items.length) return null;
  return { items: items.slice(0, MAX_ITEMS), prefix: ctx.prefix };
}
