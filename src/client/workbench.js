// <sqlite-workbench> — the whole UI. Ported from a reference implementation with
// three deliberate changes for the standalone tool:
//
//   1. SHADOW DOM + self-contained styles (below). The reference rendered into
//      the light DOM so the host app's Tailwind cascaded in; a standalone tool
//      wants the opposite - it can't depend on, or leak into, any host page.
//   2. A tiny in-component fetch wrapper on a configurable API base (the `base`
//      attribute, default "/api") instead of the app's shared api.js helpers.
//   3. Write capability comes from GET {base}/capabilities, not the host app's
//      admin session.
//
// DESKTOP-ONLY BY DESIGN: full-viewport layout with a drag-to-resize splitter.
//
// Two safety behaviours the UI makes obvious, both enforced server-side:
//   * read-only users run on a READONLY connection - SQLite rejects any write.
//   * a write runs in a transaction ROLLED BACK unless the user commits, so the
//     default outcome of a mistake is "nothing happened, here's what it would
//     have changed".

import { LitElement, html, css } from "lit";

// Result cells longer than this are truncated with an ellipsis; click for the
// full value. Keeps every result row exactly one line high. The Wrap toggle
// above the grid turns truncation off and lets long values (descriptions,
// addresses, JSON) wrap over several lines instead.
const MAX_CELL = 40;

// Width a wrapped column is held to, so one long value can't push every other
// column off the screen.
const WRAP_COL_WIDTH = "42ch";

// LIMIT put into the SELECT when you browse a table from the ↳ link. Well under
// the server's 1000-row cap, so a browse shows a complete result.
const BROWSE_LIMIT = 500;

// Shell-quote an argument so a copied command works even when a project name has
// spaces or parens (e.g. "prod db (eu-west)"). Mirrors scripts/remote.js.
function shQuote(a) {
  const s = String(a);
  return /[^A-Za-z0-9_@%+=:,./-]/.test(s) ? `'${s.replace(/'/g, "'\\''")}'` : s;
}

// ---- CSV / text export -----------------------------------------------------
function csvCell(v) {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function toCsv(columns, rows) {
  return [columns.map(csvCell).join(","), ...rows.map((r) => columns.map((c) => csvCell(r[c])).join(","))].join("\n");
}
function toTsv(columns, rows) {
  const cell = (v) => (v === null || v === undefined ? "" : String(v).replace(/\t/g, " "));
  return [columns.join("\t"), ...rows.map((r) => columns.map((c) => cell(r[c])).join("\t"))].join("\n");
}
function download(name, text) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

// ---- lightweight SQL colouring (STATIC text only) --------------------------
// Used for the CREATE statement on a schema tab. NOT for the editor: a
// <textarea> can't style a range of its own text.
const SQL_KEYWORDS = new Set([
  "ADD","ALL","ALTER","AND","AS","ASC","AUTOINCREMENT","BEGIN","BETWEEN","BLOB","BOOLEAN","BY",
  "CASE","CAST","CHECK","COLLATE","COLUMN","COMMIT","CONSTRAINT","CREATE","CROSS","CURRENT_TIMESTAMP",
  "DATE","DATETIME","DEFAULT","DELETE","DESC","DISTINCT","DROP","ELSE","END","EXISTS","FOREIGN","FROM",
  "FULL","GROUP","HAVING","IF","IN","INDEX","INNER","INSERT","INT","INTEGER","INTO","IS","JOIN","KEY",
  "LEFT","LIKE","LIMIT","NOT","NULL","NUMERIC","OFFSET","ON","OR","ORDER","OUTER","PRIMARY","REAL",
  "REFERENCES","RIGHT","ROLLBACK","SELECT","SET","TABLE","TEXT","THEN","TRANSACTION","UNION","UNIQUE",
  "UPDATE","VALUES","VARCHAR","VIEW","WHEN","WHERE","WITH",
]);
const SQL_TOKEN = /(--[^\n]*|\/\*[\s\S]*?\*\/)|('(?:[^']|'')*')|(\b\d+(?:\.\d+)?\b)|([A-Za-z_][A-Za-z0-9_]*)|(\s+)|([\s\S])/g;

function sqlTokens(src) {
  const out = [];
  SQL_TOKEN.lastIndex = 0;
  let m;
  while ((m = SQL_TOKEN.exec(String(src ?? ""))) !== null) {
    if (m[1])      out.push({ t: "comment", v: m[1] });
    else if (m[2]) out.push({ t: "string",  v: m[2] });
    else if (m[3]) out.push({ t: "number",  v: m[3] });
    else if (m[4]) out.push({ t: SQL_KEYWORDS.has(m[4].toUpperCase()) ? "kw" : "plain", v: m[4] });
    else           out.push({ t: "plain",   v: m[5] ?? m[6] });
  }
  return out;
}
const highlightSql = (src) =>
  sqlTokens(src).map((tok) => (tok.t === "plain" ? tok.v : html`<span class="tok-${tok.t}">${tok.v}</span>`));

let tabSeq = 0;
const sqlTab    = (sql = "") => ({ id: ++tabSeq, name: `Query ${tabSeq}`, kind: "sql", sql, snippetId: null });
const schemaTab = (schema)   => ({ id: ++tabSeq, name: schema.name, kind: "schema", schema });

// Open tabs survive navigation and refresh. sessionStorage NOT localStorage: a
// query can hold personal data, and sessionStorage is wiped when the tab closes,
// so working SQL doesn't outlive the session on a shared machine. Results are
// deliberately not persisted (re-runnable, can be 1000 rows).
const STORE_KEY = "sqlite-workbench.tabs";

function loadTabState() {
  try {
    const s = JSON.parse(sessionStorage.getItem(STORE_KEY) || "null");
    if (!s || !Array.isArray(s.tabs) || s.tabs.length === 0) return null;
    return s;
  } catch { return null; }
}

class SqlWorkbench extends LitElement {
  static properties = {
    _tables:   { state: true },
    _snippets: { state: true },
    _tabs:     { state: true },
    _active:   { state: true },
    _result:   { state: true },
    _cellView: { state: true },
    _wrapCells: { state: true },
    _docTables:{ state: true },
    _docBusy:  { state: true },
    _topH:     { state: true },
    _availH:   { state: true },
    _error:    { state: true },
    _notice:   { state: true },
    _busy:     { state: true },
    _canWrite: { state: true },
    _databases:{ state: true },   // { current, local[], projects[] } | null
    _projectInfo: { state: true },// a remote project shown in the "how to" modal | null
    _scripts:  { state: true },   // { investigate?, edit? } cached full scripts
    _scriptOpen:{ state: true },  // { investigate?:bool, edit?:bool }
    _version:  { state: true },   // server version string, for the header
  };

  constructor() {
    super();
    this.base = "/api";
    this._tables = [];
    this._snippets = [];

    const saved = loadTabState();
    if (saved) {
      this._tabs = saved.tabs;
      tabSeq = Math.max(0, ...saved.tabs.map((t) => Number(t.id) || 0));
      this._active = saved.tabs.some((t) => t.id === saved.active) ? saved.active : saved.tabs[0].id;
      this._topH = Number(saved.topH) || 260;
    } else {
      this._tabs = [sqlTab()];
      this._active = this._tabs[0].id;
      this._topH = 260;
    }

    this._result = null;
    this._cellView = null;
    this._wrapCells = !!saved?.wrapCells;
    this._docTables = null;
    this._docBusy = false;
    this._availH = 0;
    this._error = "";
    this._notice = "";
    this._busy = false;
    this._canWrite = false;
    this._databases = null;
    this._projectInfo = null;
    this._scripts = {};
    this._scriptOpen = {};
    this._version = "";
  }

  async connectedCallback() {
    super.connectedCallback();
    this.base = this.getAttribute("base") || "/api";
    await Promise.all([this._loadCaps(), this._loadTables(), this._loadSnippets(), this._loadDatabases()]);
  }

  firstUpdated() {
    this._measure();
    this._onResize = () => this._measure();
    window.addEventListener("resize", this._onResize);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    if (this._onResize) window.removeEventListener("resize", this._onResize);
    this._persist();
  }

  updated() { this._persist(); }

  _persist() {
    try {
      sessionStorage.setItem(STORE_KEY, JSON.stringify({
        tabs: this._tabs, active: this._active, topH: this._topH,
        wrapCells: this._wrapCells,
      }));
    } catch { /* quota / private mode - losing scratch state isn't fatal */ }
  }

  _measure() {
    const top = this.getBoundingClientRect().top;
    this._availH = Math.max(360, Math.round(window.innerHeight - top - 12));
  }

  get _tab() { return this._tabs.find((t) => t.id === this._active) ?? this._tabs[0]; }
  get _isSql() { return this._tab?.kind === "sql"; }

  // ---- API ------------------------------------------------------------------
  async _api(method, path, body) {
    const init = { method, headers: {}, credentials: "same-origin", cache: "no-store" };
    if (body !== undefined) { init.headers["content-type"] = "application/json"; init.body = JSON.stringify(body); }
    const res = await fetch(this.base + path, init);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }
  _get(p) { return this._api("GET", p); }
  _post(p, b) { return this._api("POST", p, b); }
  _put(p, b) { return this._api("PUT", p, b); }
  _del(p) { return this._api("DELETE", p); }

  // ---- data -----------------------------------------------------------------
  async _loadCaps() {
    try {
      const caps = await this._get("/capabilities");
      this._canWrite = !!caps.canWrite;
      this._version = caps.version ?? "";
    } catch { this._canWrite = false; }
  }

  async _loadTables() {
    try { this._tables = (await this._get("/tables")).tables ?? []; }
    catch (e) { this._error = e.message; }
  }

  async _loadSnippets() {
    try { this._snippets = (await this._get("/snippets")).snippets ?? []; }
    catch { this._snippets = []; }
  }

  async _loadDatabases() {
    try { this._databases = await this._get("/databases"); }
    catch { this._databases = null; }
  }

  // The <select> value for the currently-connected database.
  _connectValue() {
    const cur = this._databases?.current?.name;
    const local = this._databases?.local?.some((l) => l.name === cur);
    return local ? `local:${cur}` : "current";
  }

  _onConnectChange(e) {
    const val = e.target.value;
    if (val === "current") return;
    if (val.startsWith("project:")) {
      // Remote projects can't be opened here - show the operator how. Revert the
      // dropdown to the current database (we didn't switch).
      const name = val.slice("project:".length);
      this._projectInfo = this._databases?.projects?.find((p) => p.name === name) ?? null;
      this._scripts = {};        // fresh per project
      this._scriptOpen = {};
      e.target.value = this._connectValue();
      return;
    }
    if (val.startsWith("local:")) this._connectTo(val.slice("local:".length));
  }

  // Switch the server to another local database and reload everything for it.
  async _connectTo(name) {
    this._error = ""; this._notice = ""; this._busy = true;
    try {
      await this._post("/connect", { name });
      // Schema tabs describe the OLD database - drop them; keep scratch SQL tabs.
      this._tabs = this._tabs.filter((t) => t.kind === "sql");
      if (this._tabs.length === 0) this._tabs = [sqlTab()];
      if (!this._tabs.some((t) => t.id === this._active)) this._active = this._tabs[0].id;
      this._result = null;
      await Promise.all([this._loadCaps(), this._loadTables(), this._loadSnippets(), this._loadDatabases()]);
      this._notice = `Connected to ${name}.`;
    } catch (e) {
      this._error = e.message;
      await this._loadDatabases();   // resync the dropdown to reality
    } finally {
      this._busy = false;
    }
  }

  async _openSchema(name) {
    this._error = "";
    const open = this._tabs.find((t) => t.kind === "schema" && t.name === name);
    if (open) { this._active = open.id; return; }
    try {
      const schema = await this._get(`/schema/${encodeURIComponent(name)}`);
      const t = schemaTab(schema);
      this._tabs = [...this._tabs, t];
      this._active = t.id;
    } catch (e) { this._error = e.message; }
  }

  _selectFrom(name) {
    const t = sqlTab(`SELECT * FROM "${name.replace(/"/g, '""')}" LIMIT ${BROWSE_LIMIT};`);
    t.name = `Browse ${t.id}`;
    this._tabs = [...this._tabs, t];
    this._active = t.id;
    this._result = null;
  }

  // ---- tabs -----------------------------------------------------------------
  _patchTab(patch) {
    this._tabs = this._tabs.map((t) => (t.id === this._active ? { ...t, ...patch } : t));
  }
  _addTab() { const t = sqlTab(); this._tabs = [...this._tabs, t]; this._active = t.id; this._result = null; }
  _closeTab(id) {
    if (this._tabs.length === 1) return;
    const i = this._tabs.findIndex((t) => t.id === id);
    this._tabs = this._tabs.filter((t) => t.id !== id);
    if (this._active === id) this._active = this._tabs[Math.max(0, i - 1)].id;
  }

  // ---- splitter -------------------------------------------------------------
  _startResize(ev) {
    ev.preventDefault();
    const startY = ev.clientY;
    const startH = this._topH;
    const maxH = Math.max(160, (this._availH || 720) - 260);
    const move = (e) => { this._topH = Math.max(120, Math.min(maxH, startH + (e.clientY - startY))); };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.style.userSelect = "";
    };
    document.body.style.userSelect = "none";
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  // ---- run ------------------------------------------------------------------
  async _format() {
    if (!this._isSql) return;
    const src = this._tab.sql;
    if (!src.trim()) return;
    this._error = "";
    try {
      const { format } = await import("sql-formatter");
      const out = format(src, { language: "sqlite", keywordCase: "upper" });
      if (out === src) { this._notice = "Already formatted."; return; }
      const ta = this.renderRoot?.querySelector("textarea");
      if (ta && typeof document.execCommand === "function") {
        ta.focus();
        ta.setSelectionRange(0, ta.value.length);
        if (document.execCommand("insertText", false, out)) return;
      }
      this._patchTab({ sql: out });
    } catch (e) {
      this._error = `Could not format: ${e.message}`;
    }
  }

  async _check() {
    this._error = ""; this._notice = ""; this._busy = true;
    try {
      const r = await this._post("/check", { sql: this._tab.sql });
      if (r.ok) this._notice = `Valid SQL${r.readOnly ? " (read-only)" : " — this CHANGES data"}.`;
      else this._error = r.error;
    } catch (e) { this._error = e.message; }
    finally { this._busy = false; }
  }

  async _run(commit = false) {
    this._error = ""; this._notice = ""; this._busy = true; this._result = null;
    try {
      const r = await this._post("/run", { sql: this._tab.sql, commit });
      this._result = r;
      if (r.mode === "write") this._notice = r.message;
      if (r.capped) this._notice = `Showing the first ${r.maxRows} of ${r.rowCount} rows.`;
    } catch (e) { this._error = e.message; }
    finally { this._busy = false; }
  }

  // ---- snippets -------------------------------------------------------------
  async _saveSnippet() {
    const tab = this._tab;
    if (tab.kind !== "sql" || !tab.sql.trim()) return;
    const existing = tab.snippetId ? this._snippets.find((s) => s.id === tab.snippetId) : null;
    const name = prompt("Snippet name:", existing?.name ?? tab.name);
    if (!name?.trim()) return;
    this._error = "";
    try {
      if (existing) await this._put(`/snippets/${existing.id}`, { name: name.trim(), sql: tab.sql });
      else {
        const r = await this._post("/snippets", { name: name.trim(), sql: tab.sql });
        this._patchTab({ snippetId: r.snippet.id });
      }
      this._patchTab({ name: name.trim() });
      await this._loadSnippets();
      this._notice = `Saved “${name.trim()}”.`;
    } catch (e) { this._error = e.message; }
  }

  _loadSnippet(s) {
    const t = { ...sqlTab(s.sql), name: s.name, snippetId: s.id };
    this._tabs = [...this._tabs, t];
    this._active = t.id;
    this._result = null;
  }

  async _deleteSnippet(s) {
    if (!confirm(`Delete snippet “${s.name}”?`)) return;
    this._error = "";
    try { await this._del(`/snippets/${s.id}`); await this._loadSnippets(); }
    catch (e) { this._error = e.message; }
  }

  // ---- document schema ------------------------------------------------------
  _openSchemaDoc() { this._docTables = new Set(); }
  _toggleDocTable(name, on) {
    const s = new Set(this._docTables);
    on ? s.add(name) : s.delete(name);
    this._docTables = s;
  }
  _docAll(on) { this._docTables = on ? new Set(this._tables.map((t) => t.name)) : new Set(); }

  async _downloadSchemaDoc() {
    const names = this._tables.map((t) => t.name).filter((n) => this._docTables.has(n));
    if (!names.length) return;
    this._docBusy = true; this._error = "";
    try {
      const schemas = await Promise.all(names.map((n) => this._get(`/schema/${encodeURIComponent(n)}`)));
      const stamp = new Date().toISOString().slice(0, 10);
      const parts = [
        "# database schema",
        "",
        `_Generated ${stamp} · ${names.length} table(s): ${names.join(", ")}_`,
        "",
      ];
      for (const s of schemas) {
        parts.push(`## ${s.name}${s.type === "view" ? " (view)" : ""}`, "", "```sql", s.ddl, "```", "");
      }
      download(`schema-${stamp}.md`, parts.join("\n"));
      this._docTables = null;
    } catch (e) {
      this._error = `Could not build schema doc: ${e.message}`;
    } finally {
      this._docBusy = false;
    }
  }

  _export(kind) {
    const r = this._result;
    if (!r?.rows?.length) return;
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    if (kind === "csv") download(`query-${stamp}.csv`, toCsv(r.columns, r.rows));
    else download(`query-${stamp}.txt`, toTsv(r.columns, r.rows));
  }

  // ---- render ---------------------------------------------------------------
  render() {
    const tab = this._tab;
    return html`
      <section class="wb" style=${this._availH ? `height:${this._availH}px` : ""}>
        <div class="head">
          <h1>SQL workbench</h1>
          ${this._version ? html`<span class="version" title="sqlite-workbench version">v${this._version}</span>` : ""}
          <span class="badge ${this._canWrite ? "rw" : "ro"}">${this._canWrite ? "read / write" : "read-only"}</span>
          ${this._renderConnect()}
          <span class="spacer"></span>
          <button class="link" title="Download a Markdown document of selected tables' CREATE statements"
            @click=${() => this._openSchemaDoc()}>Document schema</button>
        </div>

        ${this._error ? html`<div class="banner err">${this._error}</div>` : ""}
        ${this._notice ? html`<div class="banner notice">${this._notice}</div>` : ""}

        <!-- top row: tables + editor, one shared height -->
        <div class="top" style="height:${this._topH}px">
          <aside class="side">
            <h2>Tables</h2>
            <ul>
              ${this._tables.map((t) => html`
                <li>
                  <button class="name" title="Show schema" @click=${() => this._openSchema(t.name)}>${t.name}</button>
                  <span class="rowend">
                    <span class="count">${t.rows ?? "—"}</span>
                    <button class="browse" title=${`Browse rows — SELECT * FROM ${t.name} LIMIT ${BROWSE_LIMIT}`}
                      @click=${() => this._selectFrom(t.name)}>↳</button>
                  </span>
                </li>
              `)}
            </ul>

            <h2 class="mt">Snippets</h2>
            ${this._snippets.length === 0
              ? html`<p class="muted">None saved yet.</p>`
              : html`
                <ul>
                  ${this._snippets.map((s) => html`
                    <li>
                      <button class="name" title=${`${s.sql}\n\n— ${s.owner ?? "unknown"}`}
                        @click=${() => this._loadSnippet(s)}>${s.name}</button>
                      <button class="del" title="Delete snippet" @click=${() => this._deleteSnippet(s)}>✕</button>
                    </li>
                  `)}
                </ul>
              `}
          </aside>

          <div class="editor">
            <div class="tabs">
              ${this._tabs.filter((t) => t.kind === "sql").map((t) => this._renderTab(t))}
              <button class="addtab" @click=${() => this._addTab()}>+ tab</button>
              ${this._tabs.some((t) => t.kind === "schema")
                ? html`<span class="schematabs">${this._tabs.filter((t) => t.kind === "schema").map((t) => this._renderTab(t))}</span>`
                : ""}
            </div>
            ${tab.kind === "schema"
              ? this._renderSchemaTab(tab)
              : html`
                <textarea class="sql" spellcheck="false"
                  placeholder="One statement per run, e.g.  SELECT * FROM users LIMIT 20;"
                  .value=${tab.sql}
                  @input=${(e) => this._patchTab({ sql: e.target.value })}></textarea>
              `}
          </div>
        </div>

        <div class="dragbar" title="Drag to resize" @pointerdown=${(e) => this._startResize(e)}></div>

        <div class="toolbar">
          <button class="btn" ?disabled=${!this._isSql || !tab.sql?.trim()}
            title="Pretty-print this SQL (Ctrl+Z undoes it)" @click=${() => this._format()}>Format</button>
          <button class="btn" ?disabled=${this._busy || !this._isSql} @click=${() => this._check()}>Check</button>
          <button class="btn primary" ?disabled=${this._busy || !this._isSql || !tab.sql?.trim()}
            @click=${() => this._run(false)}>${this._busy ? "Running…" : "Run"}</button>
          ${this._canWrite && this._result?.mode === "write" && !this._result.committed
            ? html`<button class="btn commit" @click=${() => this._run(true)}
                title="Re-run this statement and COMMIT the change">Run and Commit Change</button>`
            : ""}
          <button class="btn" ?disabled=${!this._isSql || !tab.sql?.trim()}
            @click=${() => this._saveSnippet()}>Save snippet</button>
          <span class="spacer"></span>
          ${this._result?.rows?.length
            ? html`
              <button class="btn" @click=${() => this._export("csv")}>Export CSV</button>
              <button class="btn" @click=${() => this._export("txt")}>Export text</button>`
            : ""}
        </div>

        ${this._renderResult()}
        ${this._renderCellModal()}
        ${this._renderSchemaDoc()}
        ${this._renderProjectInfo()}
      </section>
    `;
  }

  // "Connect to:" — local databases in the data dir, then remote projects. A
  // local pick switches the connection; a project pick explains the ops flow.
  _renderConnect() {
    const dbs = this._databases;
    if (!dbs) return "";
    const cur = dbs.current?.name;
    const curIsLocal = dbs.local?.some((l) => l.name === cur);
    return html`
      <label class="connect">Connect to:
        <select @change=${(e) => this._onConnectChange(e)}>
          ${curIsLocal ? "" : html`<option value="current" selected>${cur} (current)</option>`}
          <optgroup label="Local databases">
            ${(dbs.local ?? []).map(
              (l) => html`<option value="local:${l.name}" ?selected=${l.name === cur}>${l.name}</option>`
            )}
          </optgroup>
          ${dbs.projects?.length
            ? html`<optgroup label="Projects (remote)">
                ${dbs.projects.map((p) => html`<option value="project:${p.name}">${p.name}  ↗</option>`)}
              </optgroup>`
            : ""}
        </select>
      </label>
    `;
  }

  // A dark command block with a Copy button, like a fenced code block.
  _cmdBlock(text) {
    return html`
      <div class="cmdwrap">
        <pre class="cmd">${text}</pre>
        <button class="copybtn" title="Copy to clipboard" @click=${(e) => this._copy(text, e)}>Copy</button>
      </div>
    `;
  }

  async _copy(text, ev) {
    const btn = ev.currentTarget;
    let ok = false;
    try { await navigator.clipboard.writeText(text); ok = true; } catch { ok = false; }
    if (!ok) {
      // Fallback for non-secure contexts / older browsers.
      try {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        this.renderRoot.appendChild(ta);
        ta.select();
        ok = document.execCommand("copy");
        ta.remove();
      } catch { ok = false; }
    }
    const prev = btn.textContent;
    btn.textContent = ok ? "Copied!" : "Copy failed";
    btn.classList.toggle("ok", ok);
    setTimeout(() => { btn.textContent = prev; btn.classList.remove("ok"); }, 1200);
  }

  async _toggleScript(action) {
    const open = { ...this._scriptOpen, [action]: !this._scriptOpen[action] };
    this._scriptOpen = open;
    if (open[action] && this._scripts[action] == null) {
      const name = this._projectInfo?.name;
      try {
        const r = await this._get(`/project-script?name=${encodeURIComponent(name)}&action=${action}`);
        this._scripts = { ...this._scripts, [action]: r.script };
      } catch (e) {
        this._scripts = { ...this._scripts, [action]: `# could not load script: ${e.message}` };
      }
    }
  }

  // One project action: the wrapper command, plus an expander showing the exact
  // script it runs (view / copy / run by hand).
  _projectAction(action, label, cmd) {
    const open = this._scriptOpen[action];
    const script = this._scripts[action];
    return html`
      <p class="cmdlabel">${label}:</p>
      ${this._cmdBlock(cmd)}
      <button class="scripttoggle" @click=${() => this._toggleScript(action)}>
        ${open ? "▾ Hide script" : "▸ Show script"}
      </button>
      ${open
        ? script == null
          ? html`<p class="muted">Loading…</p>`
          : html`<div class="scriptbox">
              <div class="scriptbar">
                <span class="scriptlang">bash</span>
                <span class="spacer"></span>
                <button class="barcopy" title="Copy to clipboard" @click=${(e) => this._copy(script, e)}>Copy</button>
              </div>
              <pre class="scriptpre">${script}</pre>
            </div>`
        : ""}
    `;
  }

  _renderProjectInfo() {
    const p = this._projectInfo;
    if (!p) return "";
    const arg = shQuote(p.name);
    return html`
      <div class="modal" @click=${() => { this._projectInfo = null; }}>
        <div class="dialog project" @click=${(e) => e.stopPropagation()}>
          <div class="dhead">
            <h3>${p.name} — remote project</h3>
            <span class="spacer"></span>
            <button class="link" @click=${() => { this._projectInfo = null; }}>Close</button>
          </div>
          <div class="dbody">
            <p class="muted">This database lives on <code>${p.host ?? "?"}</code>${
              p.remoteDb ? html` at <code>${p.remoteDb}</code>` : ""
            }. The workbench can't open it directly — use the support scripts, which stop the
            service, work on a copy locally with guard rails, and put it back. Trust nothing you
            haven't read: expand “the exact script” to see (and run) every command yourself.</p>
            ${this._projectAction("investigate", "Investigate (read-only)",
              `bun run scripts/remote.js investigate ${arg}`)}
            ${this._projectAction("edit", "Edit (stop → download → edit → verify → upload → restart)",
              `bun run scripts/remote.js edit ${arg}`)}
            <p class="muted foot">Full runbook: <code>docs/OPERATIONS.md</code>. Print a script
            without the browser: <code>bun run scripts/remote.js edit ${arg} --script</code>.</p>
          </div>
        </div>
      </div>
    `;
  }

  _renderTab(t) {
    const on = t.id === this._active;
    const cls = ["tab", t.kind === "schema" ? "schema" : "query", on ? "on" : ""].join(" ");
    return html`
      <span class=${cls}>
        <button class="tabname" @click=${() => { this._active = t.id; this._result = null; }}>
          ${t.kind === "schema" ? html`<span class="ico">▤</span>` : ""}${t.name}
        </button>
        ${this._tabs.length > 1
          ? html`<button class="tabclose" title="Close" @click=${() => this._closeTab(t.id)}>✕</button>`
          : ""}
      </span>
    `;
  }

  _renderSchemaTab(tab) {
    const s = tab.schema;
    return html`
      <div class="schemaview">
        <p class="muted">${s.type} · read-only</p>
        <table class="schema">
          <thead>
            <tr><th>Column</th><th>Type</th><th>Not null</th><th>Default</th><th>PK</th></tr>
          </thead>
          <tbody>
            ${s.columns.map((c) => html`
              <tr>
                <td class="mono">${c.name}</td>
                <td class="dim">${c.type}</td>
                <td class="dim">${c.notnull ? "yes" : ""}</td>
                <td class="dim">${c.dflt_value ?? ""}</td>
                <td class="dim">${c.pk ? "yes" : ""}</td>
              </tr>
            `)}
          </tbody>
        </table>
        ${s.foreignKeys?.length
          ? html`<p class="muted">Foreign keys:
              ${s.foreignKeys.map((f) => html`<code class="fk">${f.from} → ${f.table}.${f.to}</code>`)}</p>`
          : ""}
        <pre class="ddl">${highlightSql(s.ddl)}</pre>
      </div>
    `;
  }

  _renderResult() {
    const r = this._result;
    if (!r) return "";
    if (r.mode === "write") {
      return html`<p class="writemsg ${r.committed ? "ok" : "pending"}">${r.message}</p>`;
    }
    if (!r.rows.length) return html`<p class="muted norows">No rows. (${r.ms}ms)</p>`;
    return html`
      <div class="resultwrap">
        <p class="resultmeta">
          ${r.rowCount} row(s) · ${r.ms}ms${r.capped ? ` · showing first ${r.maxRows}` : ""}
          <label class="wraptoggle" title="Wrap long values over several lines instead of truncating them">
            <input type="checkbox" .checked=${this._wrapCells}
              @change=${(e) => { this._wrapCells = e.target.checked; this._persist(); }} />
            Wrap
          </label>
        </p>
        <div class="grid">
          <table class="results ${this._wrapCells ? "wrapped" : ""}">
            <thead>
              <tr>${r.columns.map((c) => html`<th>${c}</th>`)}</tr>
            </thead>
            <tbody>
              ${r.rows.map((row) => html`<tr>${r.columns.map((c) => this._cell(c, row[c]))}</tr>`)}
            </tbody>
          </table>
        </div>
      </div>
    `;
  }

  _cell(column, value) {
    if (value === null || value === undefined) return html`<td class="null">null</td>`;
    const s = String(value);
    // Wrap mode shows the whole value over as many lines as it needs, so there is
    // nothing to truncate and no click-through needed.
    if (this._wrapCells) return html`<td class="wrap">${s}</td>`;
    if (s.length <= MAX_CELL) return html`<td>${s}</td>`;
    return html`
      <td>
        <button class="cellmore" title="Click to show the full value"
          @click=${() => { this._cellView = { column, value: s }; }}>${s.slice(0, MAX_CELL)}…</button>
      </td>
    `;
  }

  _renderSchemaDoc() {
    const sel = this._docTables;
    if (!sel) return "";
    const count = sel.size;
    return html`
      <div class="modal" @click=${() => { this._docTables = null; }}>
        <div class="dialog" @click=${(e) => e.stopPropagation()}>
          <div class="dhead">
            <h3>Document schema</h3>
            <span class="spacer"></span>
            <button class="link" @click=${() => this._docAll(true)}>Select all</button>
            <button class="link" @click=${() => this._docAll(false)}>Clear</button>
          </div>
          <p class="dbody muted">Tick the tables to include. Downloads a Markdown file of their
            <code>CREATE TABLE</code> statements.</p>
          <ul class="doclist">
            ${this._tables.map((t) => html`
              <li>
                <label>
                  <input type="checkbox" .checked=${sel.has(t.name)}
                    @change=${(e) => this._toggleDocTable(t.name, e.target.checked)}>
                  <span>${t.name}</span>
                  ${t.type === "view" ? html`<span class="tag">view</span>` : ""}
                </label>
              </li>
            `)}
          </ul>
          <div class="dfoot">
            <span class="muted">${count} selected</span>
            <span class="spacer"></span>
            <button class="btn" @click=${() => { this._docTables = null; }}>Cancel</button>
            <button class="btn primary" ?disabled=${count === 0 || this._docBusy}
              @click=${() => this._downloadSchemaDoc()}>${this._docBusy ? "Building…" : "Download .md"}</button>
          </div>
        </div>
      </div>
    `;
  }

  _renderCellModal() {
    const v = this._cellView;
    if (!v) return "";
    return html`
      <div class="modal" @click=${() => { this._cellView = null; }}>
        <div class="dialog wide" @click=${(e) => e.stopPropagation()}>
          <div class="dhead">
            <h3>${v.column}</h3>
            <span class="muted">${v.value.length} chars</span>
            <span class="spacer"></span>
            <button class="link" @click=${() => { this._cellView = null; }}>Close</button>
          </div>
          <pre class="cellfull">${v.value}</pre>
        </div>
      </div>
    `;
  }

  static styles = css`
    :host {
      --border: #e5e7eb; --border-strong: #d1d5db;
      --ink: #1f2937; --muted: #6b7280; --dim: #4b5563;
      --slate: #1e293b; --slate-hover: #334155;
      --indigo-bg: #eef2ff; --indigo-border: #c7d2fe; --indigo-ink: #3730a3;
      --amber-bg: #fef3c7; --amber-border: #fcd34d; --amber-ink: #92400e; --amber: #d97706;
      display: block; height: 100vh; overflow: hidden;
      font-family: ui-sans-serif, system-ui, -apple-system, sans-serif;
      color: var(--ink); font-size: 14px; background: #fff;
    }
    * { box-sizing: border-box; }
    button { font: inherit; cursor: pointer; }
    .spacer { flex: 1; }
    .muted { color: var(--muted); font-size: 12px; }
    .mono, .sql, .ddl, .cellfull, .results, .schema { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }

    .wb { display: flex; flex-direction: column; gap: 8px; height: 100vh; padding: 12px 16px; }

    .head { display: flex; align-items: baseline; gap: 12px; }
    .head h1 { font-size: 18px; font-weight: 600; margin: 0; }
    .version { font-size: 11px; color: var(--muted); font-variant-numeric: tabular-nums; align-self: center; }
    .badge { font-size: 12px; padding: 1px 8px; border-radius: 999px; border: 1px solid; }
    .badge.ro { background: #f3f4f6; color: var(--muted); border-color: var(--border-strong); }
    .badge.rw { background: var(--amber-bg); color: var(--amber-ink); border-color: var(--amber-border); }
    .link { background: none; border: 0; color: var(--dim); font-size: 14px;
      text-decoration: underline dotted; text-underline-offset: 2px; padding: 0; }
    .link:hover { color: var(--ink); }
    .connect { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--muted); }
    .connect select { font: inherit; font-size: 13px; color: var(--ink); padding: 3px 6px;
      border: 1px solid var(--border-strong); border-radius: 6px; background: #fff; max-width: 22rem; }
    .connect select:focus { outline: none; border-color: #64748b; }
    .cmdlabel { margin: 1.1rem 0 0.4rem; font-size: 13px; }
    .cmdwrap { position: relative; margin: 0; }
    .cmd { margin: 0; padding: 12px 14px; padding-right: 4.5rem; background: var(--slate); color: #f1f5f9;
      border-radius: 6px; font-size: 12px; overflow: auto; }
    .copybtn { position: absolute; top: 7px; right: 7px; font: inherit; font-size: 11px;
      padding: 3px 9px; border-radius: 5px; border: 1px solid rgba(255,255,255,0.25);
      background: rgba(255,255,255,0.12); color: #e2e8f0; }
    .copybtn:hover { background: rgba(255,255,255,0.22); }
    .copybtn.ok { background: #16a34a; border-color: #16a34a; color: #fff; }
    .scripttoggle { display: inline-block; margin: 0.35rem 0 0.2rem; padding: 0; background: none;
      border: 0; color: var(--dim); font-size: 12px; text-decoration: underline dotted;
      text-underline-offset: 2px; }
    .scripttoggle:hover { color: var(--ink); }
    /* Script block with a header bar, so Copy never overlaps the scrollbar. */
    .scriptbox { border-radius: 6px; overflow: hidden; background: var(--slate); }
    .scriptbar { display: flex; align-items: center; gap: 8px; padding: 6px 8px 6px 12px;
      border-bottom: 1px solid rgba(255,255,255,0.1); }
    .scriptlang { font-size: 11px; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.04em; }
    .barcopy { font: inherit; font-size: 11px; padding: 3px 9px; border-radius: 5px;
      border: 1px solid rgba(255,255,255,0.25); background: rgba(255,255,255,0.12); color: #e2e8f0; }
    .barcopy:hover { background: rgba(255,255,255,0.22); }
    .barcopy.ok { background: #16a34a; border-color: #16a34a; color: #fff; }
    .scriptpre { margin: 0; padding: 12px 14px; color: #f1f5f9; font-size: 12px; line-height: 1.45;
      white-space: pre; overflow: auto; max-height: 15rem; }

    .banner { font-size: 14px; border: 1px solid; border-radius: 6px; padding: 6px 12px; }
    .banner.err { background: #fef2f2; border-color: #fecaca; color: #991b1b; }
    .banner.notice { background: #f8fafc; border-color: var(--border); color: #1e293b; }

    .top { display: grid; grid-template-columns: 240px 1fr; gap: 12px; flex-shrink: 0; }
    /* min-height:0 so scrolling children scroll instead of stretching the row */
    .side { border: 1px solid var(--border); border-radius: 6px; overflow: auto; min-height: 0; padding: 8px; }
    .side h2 { font-size: 11px; text-transform: uppercase; letter-spacing: .05em; color: var(--muted);
      margin: 0 0 4px; padding: 0 4px; font-weight: 600; }
    .side h2.mt { margin-top: 12px; }
    .side ul { list-style: none; margin: 0; padding: 0; font-size: 14px; }
    .side li { display: flex; align-items: center; justify-content: space-between; gap: 4px; padding: 2px 0; }
    .side .name { background: none; border: 0; color: var(--slate); padding: 0; text-align: left;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .side .name:hover { text-decoration: underline; }
    .rowend { display: flex; align-items: center; gap: 4px; flex-shrink: 0; }
    .count { font-size: 10px; color: #9ca3af; font-variant-numeric: tabular-nums; }
    .browse { font-size: 11px; line-height: 1; border: 0; border-radius: 4px; padding: 4px 6px;
      color: var(--muted); background: none; transition: background-color .12s, color .12s; }
    .browse:hover { background: var(--slate-hover); color: #fff; }
    .del { font-size: 11px; color: #9ca3af; background: none; border: 0; flex-shrink: 0; }
    .del:hover { color: #dc2626; }

    .editor { display: flex; flex-direction: column; min-width: 0; min-height: 0; }
    .tabs { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; flex-shrink: 0; }
    .schematabs { margin-left: auto; display: flex; align-items: center; gap: 4px; flex-wrap: wrap; }
    .addtab { font-size: 12px; padding: 4px 8px; color: var(--dim); background: none; border: 0; }
    .addtab:hover { color: var(--ink); }
    .tab { display: inline-flex; align-items: center; border-radius: 6px 6px 0 0;
      border: 1px solid transparent; border-bottom: 0; padding: 4px 8px; font-size: 12px; }
    .tab .tabname { background: none; border: 0; padding: 0; color: inherit; }
    .tab.query { background: #f9fafb; border-color: var(--border); color: var(--muted); }
    .tab.query.on { background: #fff; border-color: var(--border-strong); color: var(--ink); font-weight: 500; }
    .tab.schema { background: #f5f3ff; border-color: var(--indigo-border); color: #4f46e5; }
    .tab.schema.on { background: var(--indigo-bg); border-color: var(--indigo-border);
      color: var(--indigo-ink); font-weight: 500; }
    .tab .ico { opacity: .6; margin-right: 4px; }
    .tabclose { margin-left: 6px; opacity: .5; background: none; border: 0; color: inherit; }
    .tabclose:hover { opacity: 1; color: #dc2626; }

    textarea.sql { flex: 1; min-height: 0; resize: none; width: 100%;
      border: 1px solid var(--border-strong); border-radius: 6px; padding: 6px 8px; font-size: 13px; }
    textarea.sql:focus { outline: none; border-color: #64748b; }

    .schemaview { border: 1px solid var(--indigo-border); border-radius: 0 0 6px 6px; flex: 1;
      min-height: 0; overflow: auto; padding: 8px; background: rgba(238,242,255,.4); }
    table.schema { width: 100%; font-size: 12px; border-collapse: collapse; margin-bottom: 8px; }
    table.schema th { text-align: left; color: var(--muted); border-bottom: 1px solid var(--border);
      padding: 4px 8px 4px 0; font-weight: 500; }
    table.schema td { padding: 2px 8px 2px 0; }
    table.schema td.dim { color: var(--dim); }
    .fk { margin-right: 8px; }
    code { background: rgba(127,127,127,.14); padding: 1px 5px; border-radius: 4px; font-size: 12px; }
    .ddl { font-size: 11px; background: #fff; border: 1px solid var(--border); border-radius: 6px;
      padding: 8px; overflow: auto; margin: 0; }
    .tok-kw { color: #4338ca; font-weight: 600; }
    .tok-string { color: #047857; }
    .tok-number { color: #b45309; }
    .tok-comment { color: #9ca3af; font-style: italic; }

    .dragbar { height: 6px; border-radius: 4px; background: #e5e7eb; cursor: row-resize; flex-shrink: 0; }
    .dragbar:hover { background: #94a3b8; }

    .toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; flex-shrink: 0; }
    .btn { font-size: 14px; border-radius: 6px; padding: 6px 12px; border: 1px solid var(--border-strong);
      background: #fff; color: var(--ink); }
    .btn:hover:not(:disabled) { background: #f9fafb; }
    .btn:disabled { opacity: .4; cursor: default; }
    .btn.primary { background: var(--slate); color: #fff; border-color: var(--slate); }
    .btn.primary:hover:not(:disabled) { background: var(--slate-hover); }
    .btn.commit { background: var(--amber); color: #fff; border-color: var(--amber); }
    .btn.commit:hover:not(:disabled) { background: #f59e0b; }

    .writemsg { font-size: 14px; margin: 0; }
    .writemsg.ok { color: #166534; }
    .writemsg.pending { color: var(--amber-ink); }
    .norows { margin: 0; }

    .resultwrap { flex: 1; min-height: 0; display: flex; flex-direction: column; }
    .resultmeta { font-size: 12px; color: var(--muted); margin: 0 0 4px; flex-shrink: 0; }
    .grid { flex: 1; min-height: 0; overflow: auto; border: 1px solid var(--border); border-radius: 6px; }
    table.results { font-size: 12px; border-collapse: collapse; white-space: nowrap; }
    table.results thead { position: sticky; top: 0; background: #f9fafb; }
    table.results th { text-align: left; color: var(--dim); border-bottom: 1px solid var(--border);
      padding: 4px 8px; font-weight: 500; }
    table.results td { padding: 2px 8px; border-bottom: 1px solid var(--border); }
    table.results tbody tr:nth-child(even) { background: #f1f5f9; }
    table.results tbody tr:hover { background: #e0f2fe; }
    table.results td.null { color: #9ca3af; font-style: italic; }
    .cellmore { background: none; border: 0; padding: 0; color: var(--slate); text-align: left;
      text-decoration: underline dotted; text-underline-offset: 2px; }
    /* Wrap mode: let long values run onto several lines, but cap the column so one
       description can't push the rest of the row off screen. */
    table.results.wrapped { white-space: normal; }
    table.results td.wrap { white-space: pre-wrap; overflow-wrap: anywhere;
      max-width: ${WRAP_COL_WIDTH}; vertical-align: top; }
    .wraptoggle { display: inline-flex; align-items: center; gap: 4px; margin-left: 10px;
      cursor: pointer; user-select: none; }
    .wraptoggle input { margin: 0; cursor: pointer; }

    .modal { position: fixed; inset: 0; z-index: 50; background: rgba(0,0,0,.4);
      display: flex; align-items: center; justify-content: center; padding: 24px; }
    .dialog { background: #fff; border-radius: 8px; box-shadow: 0 10px 30px rgba(0,0,0,.25);
      width: 100%; max-width: 28rem; max-height: 75vh; display: flex; flex-direction: column; }
    .dialog.wide { max-width: 48rem; max-height: 70vh; }
    .dialog.project { max-width: 66rem; }
    .dhead { display: flex; align-items: center; gap: 8px; border-bottom: 1px solid var(--border); padding: 8px 12px; }
    .dhead h3 { font-size: 14px; font-weight: 500; margin: 0; }
    .dbody { padding: 8px 12px 0; }
    .dialog.project .dhead { padding: 14px 20px; }
    .dialog.project .dbody { padding: 6px 20px 22px; line-height: 1.55; }
    .dialog.project .dbody .muted { font-size: 13px; }
    .dialog.project .dbody .foot { margin-top: 1.3rem; }
    .doclist { flex: 1; overflow: auto; padding: 8px 12px; margin: 0; list-style: none; font-size: 14px; }
    .doclist li { padding: 2px 0; }
    .doclist label { display: flex; align-items: center; gap: 8px; }
    .tag { font-size: 10px; color: #9ca3af; }
    .dfoot { display: flex; align-items: center; gap: 8px; border-top: 1px solid var(--border); padding: 8px 12px; }
    .cellfull { padding: 12px; font-size: 12px; overflow: auto; white-space: pre-wrap; word-break: break-word; margin: 0; }
  `;
}

customElements.define("sqlite-workbench", SqlWorkbench);
