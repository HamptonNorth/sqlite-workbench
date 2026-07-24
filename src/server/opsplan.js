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
  const sudo = p.sudo === true;

  // The database owner can't be your ssh user (e.g. it's under /opt, owned by a
  // service account). sudo:true swaps it in place with `sudo cp`, which keeps
  // the file's owner/permissions because it overwrites contents rather than
  // creating a new file.
  const backup = sudo
    ? `# 3) Back up the remote original (sudo: keeps the file's owner/permissions).
ssh -t "$HOST" "sudo cp -p \\"$DB\\" \\"$BAK\\""`
    : `# 3) Back up the remote original.
ssh -t "$HOST" "cp -p \\"$DB\\" \\"$BAK\\""`;

  const upload = sudo
    ? `# 8) Upload. You can't scp straight onto a service-owned file, so stage into
#    your home dir, then 'sudo cp' over the original (preserving its
#    owner/permissions), and clean up.
STAGE="sqlite-workbench-upload-$TS.sqlite"
scp "$COPY" "$HOST:$STAGE"
ssh -t "$HOST" "sudo rm -f \\"$DB-wal\\" \\"$DB-shm\\" && sudo cp \\"$STAGE\\" \\"$DB\\" && rm -f \\"$STAGE\\""`
    : `# 8) Upload: drop stale WAL sidecars, then replace the file.
ssh -t "$HOST" "rm -f \\"$DB-wal\\" \\"$DB-shm\\""
scp "$COPY" "$HOST:$DB"`;

  return `#!/usr/bin/env bash
# Edit "${name}". REVIEW EVERY LINE before running. This is exactly what
# 'bun run scripts/remote.js edit' automates; run it by hand if you'd rather.
set -euo pipefail

HOST=${bq(p.host)}
DB=${bq(p.remoteDb)}
TS="$(date +%Y%m%dT%H%M%S)"
COPY="./data/${slug(name)}-edit-$TS.sqlite"
BAK="$DB.bak-$TS"

# 1) Stop the live service. (-t: allocate a TTY so a remote sudo can prompt for
#    a password. Add -t to any ssh below whose command also needs sudo.)
ssh -t "$HOST" ${bq(p.stop)}

# 2) Fingerprint the remote DB (guards against a service that didn't stop).
#    No -t here: this output is captured, and a TTY would corrupt it.
BEFORE="$(ssh "$HOST" "sha256sum \\"$DB\\"" | awk '{print $1}')"

${backup}

# 4) Download a working copy.
scp "$HOST:$DB" "$COPY"

# 5) Edit it: opens the workbench (read/write). Edit in the browser, then Ctrl+C.
bun run bin/cli.js "$COPY" --write

# 6) Verify the edited copy opens cleanly.
bun -e 'import{Database}from"bun:sqlite";const d=new Database(process.argv[1],{readonly:true});const r=d.query("PRAGMA integrity_check").get();if(r.integrity_check!=="ok"){console.error("integrity FAILED",r);process.exit(1)}console.log("integrity ok")' "$COPY"

# 7) Guard: the remote must not have changed since download.
AFTER="$(ssh "$HOST" "sha256sum \\"$DB\\"" | awk '{print $1}')"
[ "$BEFORE" = "$AFTER" ] || { echo "Remote changed since download - aborting."; exit 1; }

${upload}

# 9) Restart the service.
ssh -t "$HOST" ${bq(p.start)}

echo "Done. Backup on the server: $BAK"
`;
}

export function projectScript(action, name, project) {
  return action === "investigate" ? investigateScript(name, project) : editScript(name, project);
}
