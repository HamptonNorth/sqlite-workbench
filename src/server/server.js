// Bun.serve wrapper. Binds localhost by default - a tool that can DELETE FROM
// should not be internet-reachable unless the operator explicitly asks for it
// (--host 0.0.0.0). Routing is deliberately hand-rolled: the safety-critical
// logic lives in core.js as plain functions, and this file just maps HTTP to
// those. No web framework, so a future Node port stays cheap.

import { handleTables, handleSchema, handleCheck, handleRun } from "./core.js";

const html = String.raw;

// Slice 1 landing page: prove we're connected and reading the file. Replaced by
// the real client shell in Slice 3.
function landingPage({ sqlite }) {
  const tables = sqlite.listTables();
  const walWarning = sqlite.isWal
    ? ""
    : html`<p class="warn">⚠ Journal mode is <b>${sqlite.journalMode || "unknown"}</b>, not WAL.
        Concurrent access with the host app will be contentious. Start with
        <code>--set-wal</code> to switch (explicit opt-in).</p>`;
  const rows = tables
    .map(
      (t) =>
        html`<tr><td>${t.name}</td><td class="type">${t.type}</td><td class="num">${
          t.rows ?? "—"
        }</td></tr>`
    )
    .join("");
  return html`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>SQLite Workbench</title>
    <style>
      :root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, sans-serif; }
      body { margin: 2rem auto; max-width: 44rem; padding: 0 1rem; line-height: 1.5; }
      h1 { font-size: 1.25rem; margin-bottom: 0.25rem; }
      .sub { color: #666; font-size: 0.85rem; margin-top: 0; }
      .warn { background: #fff4e5; border: 1px solid #f0c98a; color: #7a4b00; padding: 0.5rem 0.75rem; border-radius: 6px; font-size: 0.85rem; }
      table { border-collapse: collapse; width: 100%; font-size: 0.85rem; margin-top: 1rem; }
      th, td { text-align: left; padding: 0.3rem 0.5rem; border-bottom: 1px solid #ddd; }
      th { color: #666; font-weight: 600; }
      .type { color: #888; }
      .num { text-align: right; font-variant-numeric: tabular-nums; color: #555; }
      code { background: rgba(127,127,127,0.15); padding: 0.05rem 0.3rem; border-radius: 4px; }
    </style>
  </head>
  <body>
    <h1>SQLite Workbench</h1>
    <p class="sub">
      Connected: <b>${tables.length}</b> table(s)/view(s) ·
      ${sqlite.canWrite ? "read/write (--write)" : "read-only"} ·
      journal mode <b>${sqlite.journalMode || "unknown"}</b>
    </p>
    <p class="sub"><code>${sqlite.dbPath}</code></p>
    ${walWarning}
    <table>
      <thead><tr><th>name</th><th>type</th><th>rows</th></tr></thead>
      <tbody>${rows || html`<tr><td colspan="3">no tables</td></tr>`}</tbody>
    </table>
  </body>
</html>`;
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

// core.js handlers return { status, body }; adapt to a Response.
const send = (r) => json(r.body, r.status);

async function readJson(req) {
  try { return await req.json(); } catch { return {}; }
}

/**
 * Start the HTTP server.
 * @param {object} opts
 * @param {object} opts.sqlite   handle from openSqlite()
 * @param {string} opts.host
 * @param {number} opts.port
 * @param {string} opts.base     API base path (e.g. "/api")
 * @param {object} [opts.policy] { canRead(req), canWrite(req) } - Slice 6 injects
 *   real auth here. Defaults: read allowed (localhost dev), write follows --write.
 */
export function startServer({ sqlite, host, port, base = "/api", policy } = {}) {
  const canRead = policy?.canRead ?? (() => true);
  const canWrite = policy?.canWrite ?? (() => sqlite.canWrite);

  const server = Bun.serve({
    hostname: host,
    port,
    async fetch(req) {
      const url = new URL(req.url);
      const { pathname } = url;
      const method = req.method;

      if (pathname === "/" || pathname === "/index.html") {
        return new Response(landingPage({ sqlite }), {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }

      // Everything under `base` is the API. canRead gates all of it.
      if (pathname === base || pathname.startsWith(`${base}/`)) {
        const route = pathname.slice(base.length); // e.g. "/tables", "/schema/users"

        if (route === "/health") {
          return json({ ok: true, tables: sqlite.listTables().length, wal: sqlite.isWal });
        }

        if (!canRead(req)) return json({ error: "forbidden" }, 403);

        if (method === "GET" && route === "/tables") {
          return send(handleTables(sqlite));
        }

        if (method === "GET" && route.startsWith("/schema/")) {
          const name = decodeURIComponent(route.slice("/schema/".length));
          return send(handleSchema(sqlite, name));
        }

        if (method === "POST" && route === "/check") {
          const { sql } = await readJson(req);
          return send(handleCheck(sqlite, sql));
        }

        if (method === "POST" && route === "/run") {
          const body = await readJson(req);
          return send(handleRun(sqlite, {
            sql: body.sql,
            commit: body.commit === true,
            canWrite: canWrite(req),
          }));
        }

        return json({ error: "not found" }, 404);
      }

      return json({ error: "not found" }, 404);
    },
  });
  return server;
}
