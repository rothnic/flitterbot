#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function writeJson(filePath, value, mode) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, mode ? { mode } : undefined);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function runImport(args, env = {}, options = {}) {
  try {
    const stdout = execFileSync(
      process.execPath,
      ["--experimental-strip-types", path.join(process.cwd(), "scripts", "import-codex-auth-to-pi.mjs"), ...args],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: { ...process.env, ...env },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    return { ok: true, stdout, parsed: JSON.parse(stdout) };
  } catch (error) {
    if (!options.allowFailure) throw error;
    return {
      ok: false,
      stdout: typeof error.stdout === "string" ? error.stdout : "",
      stderr: typeof error.stderr === "string" ? error.stderr : "",
      status: error.status,
    };
  }
}

function main() {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "flitterbot-import-auth-e2e-"));
  const codexHome = path.join(tempHome, ".codex");
  const targetPath = path.join(tempHome, ".pi", "agent", "auth.json");
  const codexAuthPath = path.join(codexHome, "auth.json");
  const mockRefresh = {
    access: "mock-access-token",
    refresh: "mock-refresh-token",
    expires: Date.now() + 3_600_000,
    accountId: "mock-account",
  };

  try {
    writeJson(codexAuthPath, {
      tokens: {
        access_token: "old-access-token",
        refresh_token: "old-refresh-token",
      },
    });
    writeJson(
      targetPath,
      {
        openrouter: { type: "api_key", key: "existing-openrouter-key" },
      },
      0o600,
    );

    const blocked = runImport(["--codex-home", codexHome, "--target-path", targetPath], {}, { allowFailure: true });
    assert(blocked.ok === false, "import should require --yes without --dry-run");
    assert(!blocked.stderr.includes("old-refresh-token"), "failure output leaked input refresh token");

    const dryRun = runImport(["--codex-home", codexHome, "--target-path", targetPath, "--dry-run"]);
    assert(dryRun.parsed.ok === true, "dry-run should report ok");
    assert(dryRun.parsed.wrote === false, "dry-run should not write");
    assert(dryRun.parsed.refreshed === false, "dry-run should not refresh OAuth");
    assert(!dryRun.stdout.includes("old-refresh-token"), "dry-run output leaked input refresh token");
    assert(!dryRun.stdout.includes("mock-access-token"), "dry-run output leaked mock access token");
    assert(readJson(targetPath)["openai-codex"] === undefined, "dry-run should not modify target auth");

    const imported = runImport(
      ["--codex-home", codexHome, "--target-path", targetPath, "--yes"],
      { FLITTERBOT_CODEX_TO_PI_MOCK_REFRESH_JSON: JSON.stringify(mockRefresh) },
    );
    assert(imported.parsed.ok === true, "import should report ok");
    assert(imported.parsed.wrote === true, "import should write");
    assert(imported.parsed.refreshed === true, "import should refresh");
    assert(!imported.stdout.includes("mock-access-token"), "import output leaked mock access token");
    assert(!imported.stdout.includes("mock-refresh-token"), "import output leaked mock refresh token");

    const target = readJson(targetPath);
    assert(target.openrouter?.key === "existing-openrouter-key", "existing provider was not preserved");
    assert(target["openai-codex"]?.type === "oauth", "openai-codex oauth credential missing");
    assert(target["openai-codex"]?.access === mockRefresh.access, "imported access token mismatch");
    assert(target["openai-codex"]?.refresh === mockRefresh.refresh, "imported refresh token mismatch");
    assert((fs.statSync(targetPath).mode & 0o777) === 0o600, "target auth mode should be 0600");

    console.log(
      JSON.stringify(
        {
          ok: true,
          tempHome,
          targetPath,
          dryRun: dryRun.parsed,
          imported: {
            ok: imported.parsed.ok,
            provider: imported.parsed.provider,
            wrote: imported.parsed.wrote,
            targetShape: imported.parsed.targetShape,
          },
          providers: Object.keys(target),
        },
        null,
        2,
      ),
    );
  } finally {
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
}

main();
