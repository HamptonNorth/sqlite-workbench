// The project registry - the same file scripts/remote.js uses. The server reads
// it so the UI can list remote projects alongside local databases (it can't open
// a remote project directly; it shows the operator the ops commands instead).
//
// Resolution order: $SWB_PROJECTS, then ./projects.json, then
// ~/.config/sqlite-workbench/projects.json.

import { existsSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { homedir } from "node:os";

export function resolveRegistryPath(cwd = process.cwd()) {
  if (process.env.SWB_PROJECTS) return resolve(process.env.SWB_PROJECTS);
  const local = resolve(cwd, "projects.json");
  if (existsSync(local)) return local;
  return join(homedir(), ".config", "sqlite-workbench", "projects.json");
}

// The full raw project entry (host, remoteDb, stop, start, port) or null.
// Used to build the ops scripts - which need the stop/start commands loadProjects
// deliberately omits from its lighter listing.
export function getProject(name, cwd = process.cwd()) {
  const path = resolveRegistryPath(cwd);
  if (!existsSync(path)) return null;
  let reg;
  try { reg = JSON.parse(readFileSync(path, "utf8")); }
  catch { return null; }
  const p = reg.projects?.[name];
  if (!p || typeof p !== "object") return null;
  return { name, ...p };
}

// Never throws - a missing or malformed registry just means "no projects".
export function loadProjects(cwd = process.cwd()) {
  const path = resolveRegistryPath(cwd);
  if (!existsSync(path)) return [];
  let reg;
  try { reg = JSON.parse(readFileSync(path, "utf8")); }
  catch { return []; }
  const out = [];
  for (const [name, p] of Object.entries(reg.projects ?? {})) {
    if (name.startsWith("//") || typeof p !== "object" || p === null) continue;
    out.push({
      name,
      host: p.host ?? null,
      remoteDb: p.remoteDb ?? null,
      port: p.port ?? null,
    });
  }
  return out;
}
