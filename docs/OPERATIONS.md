# Operations runbook — supporting a remote SQLite project

The "I haven't touched this DB in a year, I need to edit a lookup table that has
no client UI" guide. Two jobs:

1. **Investigate** a live issue — read-only, safe.
2. **Edit** the database when a fix needs it — stop the service, work on a copy
   locally with guard rails, put it back, restart.

Both are driven by a small **project registry** so you don't have to remember
hosts, paths, or service names. The scripts are deliberately thin: they only
shell out to `ssh` / `scp` and your own stop/start commands, and they print
every command before running it. Nothing is hidden.

> The genuinely risky step — editing a SQLite file without corrupting it — is
> the workbench itself: local `--write`, one statement at a time, a dry-run that
> rolls back until you commit, and a `VACUUM INTO` snapshot before every commit.
> The scripts just automate the boring glue around it.

---

## One-time setup per project

Copy the example registry and fill it in:

```bash
cp projects.example.json projects.json      # projects.json is git-ignored
```

```jsonc
{
  "projects": {
    "aph2": {
      "host":     "rcollins@aph-server",         // anything ssh accepts
      "remoteDb": "/srv/aph2/db/aph2.sqlite",     // path on the server
      "stop":     "sudo systemctl stop aph2-diary",
      "start":    "sudo systemctl start aph2-diary",
      "port":     9999                            // local workbench port (optional)
    }
  }
}
```

Point `remoteDb` at the file the **service actually opens** (check the systemd
unit / app config) — there may be stale copies elsewhere on the box, and editing
the wrong one looks like "my change didn't take".

Add `"sudo": true` when the database is owned by a **service account** (typically
under `/opt` or `/var/lib`) so your ssh user can read but not overwrite it. The
file operations (backup and replace) then run via `sudo`: the new file is staged
into your home dir and `sudo cp`'d over the original, which keeps the original's
owner and permissions. Without it you'll get `scp: … Permission denied` on upload.

Registry resolution order: `$SWB_PROJECTS`, then `./projects.json`, then
`~/.config/sqlite-workbench/projects.json`.

Requirements: `ssh`/`scp` set up for the host (key-based auth recommended), and
whatever `stop`/`start` need. If those use `sudo`, the scripts allocate a
terminal (`ssh -t`) so you'll be **prompted for your sudo password** — once for
stop and once for restart. To avoid the prompts, configure passwordless `sudo`
for those units, or run as a user that can manage the service.

**Trust nothing you haven't read.** Two ways to see exactly what will run:

```bash
bun run scripts/remote.js edit aph2 --dry-run    # prints the plan, runs nothing
bun run scripts/remote.js edit aph2 --script     # prints a runnable bash script
```

`--script` emits a self-contained, commented script with your project's real
values — review it, or save and run it yourself instead of trusting the tool:

```bash
bun run scripts/remote.js edit aph2 --script > edit-aph2.sh
less edit-aph2.sh        # read every line
bash edit-aph2.sh        # ...then run it by hand
```

The same script is viewable in the app: the project modal's **"View the exact
script this runs"** expander shows it with a copy button.

---

> **In the app:** the workbench header has a **"Connect to:"** dropdown listing
> the databases in the data dir (switch to any with one click) followed by your
> registry **projects**. Picking a project can't open it remotely — it pops up
> the exact `investigate` / `edit` commands below.

## Investigate (read-only)

```bash
bun run scripts/remote.js investigate aph2
```

What it does:
1. `scp` the database down to `data/aph2-investigate-<timestamp>.sqlite`.
2. Opens the workbench **read-only** on that copy.

The copy is a point-in-time snapshot and may lag the last few writes — fine for
looking; **don't edit and upload it** (use `edit` for that). Delete the copy
when you're done.

_Alternative (live data):_ run the workbench on the server itself
(`--host 127.0.0.1`) and SSH-tunnel the port:
`ssh -L 9999:127.0.0.1:9999 host`. This needs the tool present on the server —
easiest as the compiled single binary. The download-a-copy flow above needs
nothing installed remotely and is usually enough.

---

## Edit (the guarded flow)

```bash
bun run scripts/remote.js edit aph2
```

Steps (each printed; destructive ones ask to confirm — `--yes` skips prompts):

1. **Stop the service** (`stop` from the registry).
2. **Fingerprint** the remote DB (`sha256sum`) — the guard for step 8.
3. **Back up the remote original** → `…/app.sqlite.bak-<timestamp>` on the server.
4. **Download** → `data/aph2-edit-<timestamp>.sqlite`.
5. **Open the workbench `--write`** on the copy. Edit in the browser — dry-run to
   see the row count, then Commit (a snapshot is taken before each commit). When
   finished, come back to the terminal and **press Enter** to continue.
6. **`PRAGMA integrity_check`** the edited copy. If it isn't `ok`, the script
   **stops and does not upload** — the remote is untouched.
7. **Re-fingerprint** the remote DB. If it changed since step 2 (a service that
   didn't actually stop, or someone else editing), the script **refuses to
   upload** rather than clobber those changes.
8. **Upload**: remove stale `-wal`/`-shm` sidecars on the server (safe: service
   is stopped), then `scp` the edited file into place.
9. **Restart the service** (`start`).

At the end you get: the remote backup path, the local copy path, and the
per-commit snapshots under `data/sql-snapshots/`.

### If something goes wrong
- **Before upload** (steps 1–7): the remote is untouched. Restart the service
  manually if needed (`ssh host '<start>'`); the pre-edit backup from step 3 is
  there too.
- **After a bad upload**: restore the backup and restart —
  `ssh host 'cp -p /srv/aph2/db/aph2.sqlite.bak-<ts> /srv/aph2/db/aph2.sqlite && <start>'`.
- Prune old `.bak-*` files on the server periodically.

---

## Doing it by hand (no scripts)

The scripts encode exactly this; run it yourself if you prefer.

```bash
DB=/srv/aph2/db/aph2.sqlite ; H=rcollins@aph-server ; TS=$(date +%Y%m%dT%H%M%S)
ssh $H "sudo systemctl stop aph2-diary"
ssh $H "sha256sum $DB"                       # note this
ssh $H "cp -p $DB $DB.bak-$TS"               # backup
scp $H:$DB ./data/aph2-$TS.sqlite            # download
bun run bin/cli.js ./data/aph2-$TS.sqlite --write   # edit, then Ctrl+C
bun -e 'import{Database}from"bun:sqlite";const d=new Database(process.argv[1],{readonly:true});console.log(d.query("PRAGMA integrity_check").get())' ./data/aph2-$TS.sqlite
ssh $H "sha256sum $DB"                       # must match the earlier one
ssh $H "rm -f $DB-wal $DB-shm"               # drop stale WAL sidecars
scp ./data/aph2-$TS.sqlite $H:$DB            # upload
ssh $H "sudo systemctl start aph2-diary"
```

---

## Why it's shaped this way

- **The service is stopped for edits.** SQLite is single-writer; editing a file
  a running app also writes is how you lose data. Stop first, always.
- **Back up before overwrite**, and **integrity-check before upload** — never
  push a file you haven't proven opens cleanly.
- **The checksum guard** catches the classic failure: the service didn't really
  stop, wrote while you were editing, and your upload would erase those writes.
- **Stale `-wal`/`-shm` removal on upload** stops an old write-ahead log being
  replayed on top of your new file (a corruption trap).
- **Orchestration stays out of the tool.** The workbench never touches the
  network or your services; that keeps its security story simple and lets you
  read/adapt the ops glue here.
