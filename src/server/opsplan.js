// Generate the exact, runnable shell script for a project's investigate / edit
// flow. This is the transparency facility: don't trust the dispatcher - read the
// script it would run, and run it by hand if you'd rather.
//
// The scripts here mirror scripts/remote.js step for step. They're plain bash
// with `set -euo pipefail`, the project's real values substituted, a comment per
// step, and the guard rails (integrity_check, checksum guard, stale-WAL removal)
// spelled out - nothing hidden.

// Single-quote a value for safe embedding in bash.
function bq(s) {
  return `'${String(s ?? "").replace(/'/g, `'\\''`)}'`;
}

// Filesystem-friendly slug for the working-copy filename.
function slug(name) {
  return String(name).replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "project";
}

export function investigateScript(name, p) {
  return `#!/usr/bin/env bash
# Investigate "${name}" (READ-ONLY). Review every line before running.
# This is exactly what 'bun run scripts/remote.js investigate' automates.
set -euo pipefail

HOST=${bq(p.host)}
DB=${bq(p.remoteDb)}
TS="$(date +%Y%m%dT%H%M%S)"
COPY="./data/${slug(name)}-investigate-$TS.sqlite"

# Download a copy (live; may lag the last few writes - for reading only).
scp "$HOST:$DB" "$COPY"

# Open the workbench read-only on the copy (Ctrl+C to stop).
bun run bin/cli.js "$COPY"

echo "Copy at $COPY - delete it when you're done."
`;
}

export function editScript(name, p) {
  return `#!/usr/bin/env bash
# Edit "${name}". REVIEW EVERY LINE before running. This is exactly what
# 'bun run scripts/remote.js edit' automates; run it by hand if you'd rather.
set -euo pipefail

HOST=${bq(p.host)}
DB=${bq(p.remoteDb)}
TS="$(date +%Y%m%dT%H%M%S)"
COPY="./data/${slug(name)}-edit-$TS.sqlite"
BAK="$DB.bak-$TS"

# 1) Stop the live service.
ssh "$HOST" ${bq(p.stop)}

# 2) Fingerprint the remote DB (guards against a service that didn't stop).
BEFORE="$(ssh "$HOST" "sha256sum \\"$DB\\"" | awk '{print $1}')"

# 3) Back up the remote original.
ssh "$HOST" "cp -p \\"$DB\\" \\"$BAK\\""

# 4) Download a working copy.
scp "$HOST:$DB" "$COPY"

# 5) Edit it: opens the workbench (read/write). Edit in the browser, then Ctrl+C.
bun run bin/cli.js "$COPY" --write

# 6) Verify the edited copy opens cleanly.
bun -e 'import{Database}from"bun:sqlite";const d=new Database(process.argv[1],{readonly:true});const r=d.query("PRAGMA integrity_check").get();if(r.integrity_check!=="ok"){console.error("integrity FAILED",r);process.exit(1)}console.log("integrity ok")' "$COPY"

# 7) Guard: the remote must not have changed since download.
AFTER="$(ssh "$HOST" "sha256sum \\"$DB\\"" | awk '{print $1}')"
[ "$BEFORE" = "$AFTER" ] || { echo "Remote changed since download - aborting."; exit 1; }

# 8) Upload: drop stale WAL sidecars, then replace the file.
ssh "$HOST" "rm -f \\"$DB-wal\\" \\"$DB-shm\\""
scp "$COPY" "$HOST:$DB"

# 9) Restart the service.
ssh "$HOST" ${bq(p.start)}

echo "Done. Backup on the server: $BAK"
`;
}

export function projectScript(action, name, project) {
  return action === "investigate" ? investigateScript(name, project) : editScript(name, project);
}
