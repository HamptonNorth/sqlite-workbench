#!/usr/bin/env bun
// Support orchestration for remote SQLite projects. THIN and TRANSPARENT by
// design: it only ever shells out to ssh / scp and the stop/start commands from
// your registry, and it PRINTS every command before running it. --dry-run prints
// the whole plan and runs nothing. See docs/OPERATIONS.md.
//
//   bun run scripts/remote.js investigate <project> [--dry-run]
//   bun run scripts/remote.js edit        <project> [--dry-run] [--yes]
//
// The safety-critical part - editing the database - is the workbench itself
// (local --write, dry-run/commit, per-commit snapshots). This script just
// automates the boring, error-prone glue around it: stop → back up → download →
// edit → verify → upload → restart, with a checksum guard so a database that
// changed under you (a service that didn't actually stop) can't be clobbered.

import { Database } from "bun:sqlite";
import { mkdirSync, existsSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { homedir } from "node:os";
import { projectScript } from "../src/server/opsplan.js";

const repoRoot = resolve(import.meta.dir, "..");
const cli = join(repoRoot, "bin", "cli.js");
const dataDir = join(repoRoot, "data");

// ---- registry --------------------------------------------------------------
function registryPath() {
  if (process.env.SWB_PROJECTS) return resolve(process.env.SWB_PROJECTS);
  const local = join(repoRoot, "projects.json");
  if (existsSync(local)) return local;
  return join(homedir(), ".config", "sqlite-workbench", "projects.json");
}

function loadProject(name) {
  const path = registryPath();
  if (!existsSync(path)) {
    die(`no project registry found (looked at ${path}).\n` +
        `Copy projects.example.json to projects.json and add your projects — see docs/OPERATIONS.md.`);
  }
  let reg;
  try { reg = JSON.parse(readFileSync(path, "utf8")); }
  catch (e) { die(`could not parse ${path}: ${e.message}`); }
  const p = reg.projects?.[name];
  if (!p) {
    const known = Object.keys(reg.projects ?? {}).filter((k) => k !== "//").join(", ") || "(none)";
    die(`unknown project "${name}" in ${path}.\nKnown projects: ${known}`);
  }
  for (const req of ["host", "remoteDb", "stop", "start"]) {
    if (!p[req]) die(`project "${name}" is missing "${req}" in ${path}`);
  }
  return { name, port: 9999, ...p };
}

// ---- shell helpers ---------------------------------------------------------
const C = { dim: "\x1b[2m", bold: "\x1b[1m", red: "\x1b[31m", green: "\x1b[32m", yellow: "\x1b[33m", reset: "\x1b[0m" };
function die(msg) { console.error(`${C.red}error:${C.reset} ${msg}`); process.exit(1); }
function step(msg) { console.log(`\n${C.bold}▸ ${msg}${C.reset}`); }
function shQuote(a) { return /[^A-Za-z0-9_@%+=:,./-]/.test(a) ? `'${a.replace(/'/g, "'\\''")}'` : a; }

// Run a command, printing it first. capture:true returns stdout.
async function run(argv, { dryRun = false, capture = false, allowFail = false } = {}) {
  // Interactive ssh (a remote `sudo systemctl …` needs a password) requires a
  // TTY, so allocate one with -t and inherit stdin so you can type it. NOT for
  // captured commands: a PTY corrupts the piped output we parse (e.g. sha256sum).
  const cmd = argv[0] === "ssh" && !capture ? ["ssh", "-t", ...argv.slice(1)] : argv;
  console.log(`  ${C.dim}$ ${cmd.map(shQuote).join(" ")}${C.reset}`);
  if (dryRun) return { code: 0, stdout: "" };
  const proc = Bun.spawn(cmd, {
    stdin: capture ? "ignore" : "inherit",
    stdout: capture ? "pipe" : "inherit",
    stderr: "inherit",
  });
  const stdout = capture ? await new Response(proc.stdout).text() : "";
  const code = await proc.exited;
  if (code !== 0 && !allowFail) die(`command failed (exit ${code})`);
  return { code, stdout };
}

function confirm(question, { yes = false } = {}) {
  if (yes) { console.log(`  ${C.dim}(--yes) ${question} → y${C.reset}`); return true; }
  const a = prompt(`  ${question} [y/N]`);
  return /^y(es)?$/i.test((a ?? "").trim());
}

const stamp = () => new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);

// sha256 of a file on the remote host (first whitespace field of sha256sum).
async function remoteSha(p, host, remoteDb, dryRun) {
  const { stdout } = await run(["ssh", host, `sha256sum ${shQuote(remoteDb)}`], { dryRun, capture: true, allowFail: true });
  return stdout.trim().split(/\s+/)[0] || null;
}

// PRAGMA integrity_check on a local copy - must be "ok" before we upload it.
function integrityOk(localPath) {
  const db = new Database(localPath, { readonly: true });
  try {
    const rows = db.query("PRAGMA integrity_check").all();
    return rows.length === 1 && rows[0].integrity_check === "ok";
  } finally { db.close(); }
}

// ---- run the workbench on a local file, blocking until the user is done ----
async function editSession(localPath, port, dryRun) {
  const argv = ["bun", "run", cli, localPath, "--write", "--port", String(port)];
  console.log(`  ${C.dim}$ ${argv.map(shQuote).join(" ")}${C.reset}`);
  if (dryRun) { console.log(`  ${C.dim}(dry-run: would open the workbench and wait)${C.reset}`); return; }
  const proc = Bun.spawn(argv, { stdout: "inherit", stderr: "inherit" });
  // The workbench is a server; it runs until stopped. Rather than have the user
  // Ctrl+C (which would also kill this script), we wait for Enter, then stop it.
  prompt(`\n  ${C.green}▶ Edit in the browser, then press Enter here to finish and upload…${C.reset}`);
  proc.kill("SIGINT");
  await proc.exited;
}

// ---- commands --------------------------------------------------------------
async function investigate(name, { dryRun }) {
  const p = loadProject(name);
  mkdirSync(dataDir, { recursive: true });
  const copy = join(dataDir, `${name}-investigate-${stamp()}.sqlite`);

  console.log(`\n${C.bold}Investigate ${name}${C.reset}  (read-only, on a downloaded copy)`);
  console.log(`  host      ${p.host}`);
  console.log(`  remote db ${p.remoteDb}`);
  console.log(`  local copy${" "}${copy}`);
  console.log(`  ${C.yellow}note:${C.reset} this is a live copy and may lag the last few writes. For a` +
              ` point-in-time investigation that's fine; do NOT edit and upload it.`);

  step("Download a copy");
  await run(["scp", `${p.host}:${p.remoteDb}`, copy], { dryRun });

  step("Open the workbench (read-only)");
  const argv = ["bun", "run", cli, copy, "--port", String(p.port)];
  console.log(`  ${C.dim}$ ${argv.map(shQuote).join(" ")}${C.reset}`);
  if (dryRun) { console.log(`  ${C.dim}(dry-run)${C.reset}`); return; }
  const proc = Bun.spawn(argv, { stdout: "inherit", stderr: "inherit" });
  await proc.exited;
  console.log(`\n  Done. The copy is at ${copy} — delete it when you're finished.`);
}

async function edit(name, { dryRun, yes }) {
  const p = loadProject(name);
  mkdirSync(dataDir, { recursive: true });
  const copy = join(dataDir, `${name}-edit-${stamp()}.sqlite`);
  const remoteBak = `${p.remoteDb}.bak-${stamp()}`;

  // A service-owned database (e.g. under /opt) can be read by your ssh user but
  // not overwritten. sudo:true does the file ops via sudo: back up and swap in
  // place with `sudo cp`, which preserves the file's owner/permissions because
  // it overwrites the existing file's contents rather than creating a new one.
  const sudo = p.sudo === true;
  const staging = `sqlite-workbench-upload-${stamp()}.sqlite`; // in the ssh user's home

  console.log(`\n${C.bold}Edit ${name}${C.reset}  (stop → download → edit → verify → upload → restart)`);
  console.log(`  host      ${p.host}`);
  console.log(`  remote db ${p.remoteDb}${sudo ? "  (sudo for file ops)" : ""}`);
  console.log(`  local copy${" "}${copy}`);
  console.log(`  remote bak${" "}${remoteBak}`);
  if (!dryRun && !confirm("This stops the live service and edits its database. Continue?", { yes })) {
    return console.log("  aborted.");
  }

  step("Stop the service");
  await run(["ssh", p.host, p.stop], { dryRun });

  step("Fingerprint the remote database (guard against a service that didn't stop)");
  const before = await remoteSha(p.remoteDb, p.host, p.remoteDb, dryRun);
  console.log(`  ${C.dim}sha256 ${before ?? "(dry-run)"}${C.reset}`);

  step("Back up the remote original");
  await run(["ssh", p.host,
    `${sudo ? "sudo " : ""}cp -p ${shQuote(p.remoteDb)} ${shQuote(remoteBak)}`], { dryRun });

  step("Download the database");
  await run(["scp", `${p.host}:${p.remoteDb}`, copy], { dryRun });

  step("Open the workbench (read / write) on the copy");
  await editSession(copy, p.port, dryRun);

  step("Verify the edited copy (PRAGMA integrity_check)");
  if (dryRun) {
    console.log(`  ${C.dim}(dry-run: would run integrity_check on ${copy})${C.reset}`);
  } else if (!integrityOk(copy)) {
    die(`integrity_check FAILED on ${copy}. NOT uploading. The remote is untouched` +
        ` (backup at ${remoteBak}); restart the service manually if needed.`);
  } else {
    console.log(`  ${C.green}ok${C.reset}`);
  }

  step("Re-check the remote fingerprint (must be unchanged since download)");
  const after = await remoteSha(p.remoteDb, p.host, p.remoteDb, dryRun);
  if (!dryRun && before && after && before !== after) {
    die(`the remote database CHANGED since download (service still running?).\n` +
        `Refusing to upload and clobber those changes. Investigate; the remote is` +
        ` untouched (backup at ${remoteBak}).`);
  }
  console.log(`  ${C.dim}${dryRun ? "(dry-run)" : "unchanged ✓"}${C.reset}`);

  if (!dryRun && !confirm("Upload the edited database and overwrite the live file?", { yes })) {
    return console.log(`  aborted before upload. Remote untouched; your edited copy is at ${copy}.`);
  }

  step("Upload (remove stale WAL sidecars, then replace the file)");
  // Service is stopped, so removing stale -wal/-shm is safe and prevents an old
  // WAL being replayed over the new file.
  const rmWal = `rm -f ${shQuote(p.remoteDb + "-wal")} ${shQuote(p.remoteDb + "-shm")}`;
  if (sudo) {
    // Can't scp straight onto a service-owned file. Stage into home, then
    // `sudo cp` over the original (preserving its owner/perms), then clean up.
    await run(["scp", copy, `${p.host}:${staging}`], { dryRun });
    await run(["ssh", p.host,
      `sudo ${rmWal} && sudo cp ${shQuote(staging)} ${shQuote(p.remoteDb)} && rm -f ${shQuote(staging)}`],
      { dryRun });
  } else {
    await run(["ssh", p.host, rmWal], { dryRun });
    await run(["scp", copy, `${p.host}:${p.remoteDb}`], { dryRun });
  }

  step("Restart the service");
  await run(["ssh", p.host, p.start], { dryRun });

  console.log(`\n${C.green}✓ Done.${C.reset}`);
  console.log(`  remote backup : ${remoteBak} (on ${p.host})`);
  console.log(`  local copy    : ${copy}`);
  console.log(`  edit snapshots: ${join(dataDir, "sql-snapshots")} (per-commit restore points)`);
}

// ---- main ------------------------------------------------------------------
const [cmd, name, ...rest] = process.argv.slice(2);
const flags = new Set(rest.filter((a) => a.startsWith("--")));
const opts = { dryRun: flags.has("--dry-run"), yes: flags.has("--yes") };

if (!cmd || !name || (cmd !== "investigate" && cmd !== "edit")) {
  console.log(`Usage:
  bun run scripts/remote.js investigate <project> [--dry-run] [--script]
  bun run scripts/remote.js edit        <project> [--dry-run] [--yes] [--script]

  --dry-run   print the plan and run nothing
  --script    print a runnable, self-contained bash script and exit (nothing runs)
              — review it, or  > edit.sh  and run it yourself
  --yes       skip confirmations (edit)

Projects come from the registry (see docs/OPERATIONS.md):
  $SWB_PROJECTS, else ./projects.json, else ~/.config/sqlite-workbench/projects.json`);
  process.exit(name ? 1 : 0);
}

// --script: emit the runnable bash and exit. Nothing is executed - the whole
// point is that you can read it (and run it yourself) rather than trust us.
if (flags.has("--script")) {
  process.stdout.write(projectScript(cmd, name, loadProject(name)));
  process.exit(0);
}

if (cmd === "investigate") await investigate(name, opts);
else await edit(name, opts);
