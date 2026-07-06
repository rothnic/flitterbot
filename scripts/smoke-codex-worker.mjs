#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const result = spawnSync(
  process.execPath,
  ["--experimental-strip-types", join(root, "src/workers/smoke-codex-worker.ts"), ...process.argv.slice(2)],
  { cwd: root, stdio: "inherit" },
);

if (result.error) {
  console.error(result.error);
  process.exit(1);
}
process.exit(result.status ?? 1);

