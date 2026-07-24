// Bun.serve wrapper. Binds localhost by default - a tool that can DELETE FROM
// should not be internet-reachable unless the operator explicitly asks for it
// (--host 0.0.0.0). Routing is deliberately hand-rolled: the safety-critical
// logic lives in core.js as plain functions, and this file just maps HTTP to
// those. No web framework, so a future Node port stays cheap.

import { fileURLToPath } from "node:url";
import { readdirSync, existsSync, statSync } from "node:fs";
import { resolve, join, basename, sep } from "node:path";
import {
  handleTables, handleSchema, handleCheck, handleRun,
  handleListSnippets, handleCreateSnippet, handleUpdateSnippet, handleDeleteSnippet,
} from "./core.js";
import { loadProjects } from "./registry.js";

// Connectable databases in the data dir: .db / .sqlite files, minus the
// workbench's own sidecars. Presentational - path guards on /connect are the
// real control.
function listLocalDbs(dataDir) {
  let files;
  try { files = readdirSync(dataDir); } catch { return []; }
  return files
    .filter((f) => (f.endsWith(".db") || f.endsWith(".sqlite")) && !f.endsWith(".workbench.sqlite"))
    .sort()
    .map((f) => ({ name: f, path: join(dataDir, f) }));
}

const html = String.raw;

// ---- client assets ---------------------------------------------------------
// The UI is one Shadow-DOM web component bundled in-process with Bun.build, so
// "just run the CLI" works with no separate build step and no CDN dependency.
// Built once, lazily, and cached (keyed by the API base so the mounted element's
// `base` attribute matches --base).
const clientDir = fileURLToPath(new URL("../client/", import.meta.url));
let _assetsPromise = null;

async function buildAssets(base) {
  const res = await Bun.build({
    entrypoints: [`${clientDir}workbench.js`],
    target: "browser",
    format: "esm",
    splitting: true,
    minify: true,
  });
  if (!res.success) {
    throw new AggregateError(res.logs, "client bundle failed");
  }
  const assets = new Map();
  for (const out of res.outputs) {
    const name = "/" + out.path.replace(/^\.?\//, "");
    assets.set(name, { body: await out.text(), type: out.type || "text/javascript" });
  }
  // index.html is static; inject the configured API base into the mount point.
  let shell = await Bun.file(`${clientDir}index.html`).text();
  if (base !== "/api") shell = shell.replace('base="/api"', `base="${base}"`);
  assets.set("/", { body: shell, type: "text/html; charset=utf-8" });
  assets.set("/index.html", { body: shell, type: "text/html; charset=utf-8" });
  return assets;
}

function clientAssets(base) {
  if (!_assetsPromise) _assetsPromise = buildAssets(base);
  return _assetsPromise;
}

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
 * @param {object} opts.connection   { dbPath, sqlite, sidecar, close() } - the
 *   active connection. Swappable at runtime via POST /connect.
 * @param {function} opts.makeConnection (dbPath) -> a new connection object.
 * @param {string} opts.dataDir   directory whose databases the UI may switch to.
 * @param {string} opts.host
 * @param {number} opts.port
 * @param {string} opts.base     API base path (e.g. "/api")
 * @param {object} [opts.policy] { canRead(req), canWrite(req), whoOf(req),
 *   isAdmin(req) } - Slice 6 injects real auth here. Defaults: read allowed
 *   (localhost dev), write follows --write, identity null, not admin.
 */
export function startServer({ connection, makeConnection, dataDir, host, port, base = "/api", policy } = {}) {
  // The active connection - mutable so the UI can switch databases. Handlers
  // read `conn.sqlite` / `conn.sidecar` fresh on each request.
  let conn = connection;
  const dataDirResolved = resolve(dataDir);

  const canRead = policy?.canRead ?? (() => true);
  const canWrite = policy?.canWrite ?? (() => conn.sqlite.canWrite);
  const whoOf = policy?.whoOf ?? (() => null);
  const isAdmin = policy?.isAdmin ?? (() => false);

  const currentDb = () => ({ name: basename(conn.dbPath), path: conn.dbPath });

  const server = Bun.serve({
    hostname: host,
    port,
    async fetch(req) {
      const url = new URL(req.url);
      const { pathname } = url;
      const method = req.method;

      // Everything under `base` is the API. canRead gates all of it.
      if (pathname === base || pathname.startsWith(`${base}/`)) {
        const route = pathname.slice(base.length); // e.g. "/tables", "/schema/users"

        if (route === "/health") {
          return json({ ok: true, tables: conn.sqlite.listTables().length, wal: conn.sqlite.isWal });
        }

        // Ungated: the UI reads this before anything to show the right badge and
        // enable/disable the write path. It's a capability flag, not data.
        if (route === "/capabilities") {
          const w = canWrite(req);
          return json({ base, canWrite: w, readOnly: !w, database: currentDb() });
        }

        if (!canRead(req)) return json({ error: "forbidden" }, 403);

        // What can we connect to: the current db, local databases in the data
        // dir, and remote projects from the registry (open-by-explanation only).
        if (method === "GET" && route === "/databases") {
          return json({
            current: currentDb(),
            dataDir: dataDirResolved,
            local: listLocalDbs(dataDirResolved),
            projects: loadProjects(),
          });
        }

        // Switch the active connection to a database in the data dir. Restricted
        // to the data dir with a hard path check - the UI can't point us at
        // arbitrary files on disk.
        if (method === "POST" && route === "/connect") {
          const { name } = await readJson(req);
          const safe = String(name ?? "");
          if (!safe || safe.includes("/") || safe.includes("\\") || safe.includes("..")) {
            return json({ error: "bad database name" }, 400);
          }
          if (safe.endsWith(".workbench.sqlite")) {
            return json({ error: "that's a workbench sidecar, not a database" }, 400);
          }
          const target = resolve(join(dataDirResolved, safe));
          if (target !== join(dataDirResolved, safe) || !target.startsWith(dataDirResolved + sep)) {
            return json({ error: "outside the data directory" }, 400);
          }
          if (!existsSync(target) || !statSync(target).isFile()) {
            return json({ error: "no such database" }, 404);
          }
          try {
            const next = makeConnection(target);
            const prev = conn;
            conn = next;
            prev.close();
            return json({ ok: true, database: currentDb(), canWrite: conn.sqlite.canWrite });
          } catch (e) {
            return json({ error: `could not open database: ${e.message}` }, 500);
          }
        }

        if (method === "GET" && route === "/tables") {
          return send(handleTables(conn.sqlite));
        }

        if (method === "GET" && route.startsWith("/schema/")) {
          const name = decodeURIComponent(route.slice("/schema/".length));
          return send(handleSchema(conn.sqlite, name));
        }

        if (method === "POST" && route === "/check") {
          const { sql } = await readJson(req);
          return send(handleCheck(conn.sqlite, sql));
        }

        if (method === "POST" && route === "/run") {
          const body = await readJson(req);
          return send(handleRun(conn.sqlite, {
            sql: body.sql,
            commit: body.commit === true,
            canWrite: canWrite(req),
            who: whoOf(req),
            onExecute: conn.sidecar.appendAudit,
          }));
        }

        // ---- snippets (sidecar store) ----
        {
          const store = conn.sidecar;
          if (method === "GET" && route === "/snippets") {
            return send(handleListSnippets(store));
          }
          if (method === "POST" && route === "/snippets") {
            const body = await readJson(req);
            return send(handleCreateSnippet(store, { name: body.name, sql: body.sql, who: whoOf(req) }));
          }
          if ((method === "PUT" || method === "DELETE") && route.startsWith("/snippets/")) {
            const id = Number(route.slice("/snippets/".length));
            if (!Number.isInteger(id)) return json({ error: "bad snippet id" }, 400);
            const auth = { who: whoOf(req), isAdmin: isAdmin(req) };
            if (method === "DELETE") return send(handleDeleteSnippet(store, id, auth));
            const body = await readJson(req);
            return send(handleUpdateSnippet(store, id, { name: body.name, sql: body.sql }, auth));
          }
        }

        return json({ error: "not found" }, 404);
      }

      // Static client assets: index.html at "/" plus the bundled JS (+ chunks).
      if (method === "GET") {
        try {
          const assets = await clientAssets(base);
          const a = assets.get(pathname);
          if (a) return new Response(a.body, { headers: { "content-type": a.type } });
        } catch (e) {
          console.error(`client bundle failed: ${e?.message ?? e}`);
          // Fall back to the plain server-rendered page so the tool is still
          // usable (list of tables) even if the bundle can't be built.
          if (pathname === "/" || pathname === "/index.html") {
            return new Response(landingPage({ sqlite: conn.sqlite }), {
              headers: { "content-type": "text/html; charset=utf-8" },
            });
          }
        }
      }

      return json({ error: "not found" }, 404);
    },
  });
  return server;
}
