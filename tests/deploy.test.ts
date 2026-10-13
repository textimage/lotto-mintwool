import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync, spawn } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { parse } from "dotenv";
import { verifyPassword } from "../server/auth.js";

test("admin setup completes on hidden stdin and stores a literal hash without the plain password", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lotto-test-"));
  try {
    const password = "setup-test-only!";
    const result = await new Promise<{ code: number | null; output: string }>(
      (resolve, reject) => {
        const child = spawn(
          process.execPath,
          [
            resolvePath("node_modules/tsx/dist/cli.mjs"),
            resolvePath("scripts/setup-admin.ts"),
            "--stdin",
          ],
          { cwd: directory, stdio: ["pipe", "pipe", "pipe"] },
        );
        let output = "";
        let errors = "";
        const timeout = setTimeout(() => {
          child.kill();
          reject(new Error("Admin setup did not exit."));
        }, 15000);
        child.stdout.on("data", (part) => (output += part));
        child.stderr.on("data", (part) => (errors += part));
        child.on("error", reject);
        child.on("close", (code) => {
          clearTimeout(timeout);
          if (code !== 0) reject(new Error(errors));
          else resolve({ code, output });
        });
        child.stdin.end(
          JSON.stringify({ username: "textimage", password }) + "\n",
        );
      },
    );
    assert.equal(result.code, 0);
    const text = await readFile(join(directory, ".env"), "utf8");
    const values = parse(text);
    assert.ok(!text.includes(password));
    assert.ok(!result.output.includes(password));
    assert.ok(await verifyPassword(password, values.BOOTSTRAP_PASSWORD_HASH));
    assert.match(text, /^BOOTSTRAP_PASSWORD_HASH='scrypt\$v1\$/m);
  } finally {
    if (
      dirname(resolve(directory)) === resolve(tmpdir()) &&
      directory.includes("lotto-test-")
    )
      await rm(directory, { recursive: true, force: true });
  }
});

function resolvePath(path: string) {
  return resolve(path);
}

test("Docker Compose parses the quoted scrypt hash literally", async (t) => {
  const check = spawnSync("docker", ["compose", "version"], {
    encoding: "utf8",
    timeout: 10000,
  });
  if (check.error || check.status !== 0) {
    t.skip("Docker Compose CLI is unavailable in this test environment.");
    return;
  }
  const directory = await mkdtemp(join(tmpdir(), "lotto-test-"));
  try {
    const hash = "scrypt$v1$testSalt$testKey";
    await writeFile(
      join(directory, ".env"),
      `BOOTSTRAP_PASSWORD_HASH='${hash}'\n`,
    );
    await writeFile(
      join(directory, "compose.yaml"),
      await readFile(resolvePath("compose.yaml"), "utf8"),
    );
    // The default config renderer doubles dollar signs so its output can be reused as a Compose file.
    const result = spawnSync(
      "docker",
      ["compose", "config", "--format", "json"],
      {
        cwd: directory,
        encoding: "utf8",
        timeout: 10000,
        env: {
          ...process.env,
          APP_IMAGE: "lotto-note:compose-check",
          APP_DOMAIN: "compose-check.example",
        },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr.trim(), "");
    const configuration = JSON.parse(result.stdout);
    const rendered =
      configuration.services.app.environment.BOOTSTRAP_PASSWORD_HASH;
    assert.equal(rendered.replace(/\$\$/g, "$"), hash);
    assert.equal(configuration.services.app.image, "lotto-note:compose-check");
    assert.equal(
      configuration.services.app.environment.APP_ORIGIN,
      "https://compose-check.example",
    );
    assert.equal(configuration.volumes.app_data.name, "lotto-note_app_data");
    assert.equal(
      configuration.volumes.app_backups.name,
      "lotto-note_app_backups",
    );
  } finally {
    if (
      dirname(resolve(directory)) === resolve(tmpdir()) &&
      directory.includes("lotto-test-")
    )
      await rm(directory, { recursive: true, force: true });
  }
});
