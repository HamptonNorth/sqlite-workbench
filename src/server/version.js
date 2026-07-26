// Single source of truth for the version: package.json. Surfaced in the CLI
// banner, `--version`, GET /api/health and /api/capabilities, and the UI header,
// so a running instance can always be mapped back to a release.
import pkg from "../../package.json";

export const VERSION = pkg.version;
export const NAME = pkg.name;
