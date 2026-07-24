# data/

Default home for local development / scratch SQLite databases.

Drop a `.db` (or `.sqlite`) file here and point the tool at it:

```bash
bun run dev ./data/app.db          # read-only, hot-reload
bun run dev ./data/app.db --write  # enable editing
```

Database files in this directory are git-ignored (only this README and
`.gitkeep` are tracked) — nothing here is committed, so real data never
lands in the repo.
