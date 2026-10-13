// Mount this file read-only into the runtime image. Use temporary data/backup mounts.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { resolve } from "node:path";
import Database from "better-sqlite3";
import { Store } from "../dist/server/server/db.js";
import { hashPassword } from "../dist/server/server/auth.js";

const maintenance = resolve("dist/server/server/maintenance.js");
const db = resolve(process.env.DATA_DIR, "lotto.sqlite");
const backup = resolve(process.env.BACKUP_DIR, "deploy-runtime-check.sqlite");
function run(...args) {
  execFileSync(process.execPath, [maintenance, ...args], { stdio: "inherit" });
}
assert.equal(process.getuid(), 1000);
run("migrate");
const store = new Store(db);
const password = "container-check-only!";
store.bootstrap("container-check", await hashPassword(password));
store.saveSettings({ ...store.settings(), autoSync: false });
store.close();
run("snapshot", backup);
const changed = new Database(db);
changed.exec(
  "CREATE TABLE runtime_check(id INTEGER); UPDATE users SET username='changed'",
);
changed.close();
run("restore", backup);
const restored = new Database(db);
assert.equal(restored.pragma("quick_check", { simple: true }), "ok");
assert.equal(
  restored
    .prepare("SELECT name FROM sqlite_master WHERE name='runtime_check'")
    .get(),
  undefined,
);
assert.equal(
  restored.prepare("SELECT username FROM users").get().username,
  "container-check",
);
restored.close();
execFileSync(process.execPath, ["dist/server/scripts/telegram-qr-check.js"], {
  stdio: "inherit",
});

const server = spawn(process.execPath, ["dist/server/server/index.js"], {
  env: { ...process.env, TELEGRAM_ENABLED: "false" },
  stdio: ["ignore", "inherit", "inherit"],
});
const exit = new Promise((done) => server.once("exit", done));
try {
  let ready = false;
  for (let attempt = 0; attempt < 50; attempt++) {
    if (server.exitCode !== null)
      throw new Error("Runtime server exited before readiness");
    try {
      ready = (
        await fetch("http://127.0.0.1:3000/healthz", {
          signal: AbortSignal.timeout(1000),
        })
      ).ok;
    } catch {
      /* Wait for the local listener. */
    }
    if (ready) break;
    await new Promise((done) => setTimeout(done, 100));
  }
  assert.ok(ready, "Runtime /healthz did not become ready");
  const origin = "https://lotto.mintwool.com";
  const login = await fetch("http://127.0.0.1:3000/api/auth/login", {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({ username: "container-check", password }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const exported = await fetch("http://127.0.0.1:3000/api/backup", {
    headers: { Cookie: cookie },
  });
  assert.equal(exported.status, 200);
  assert.equal((await exported.json()).schemaVersion, 2);
  console.log(
    "Runtime checks passed: UID 1000, migrations, snapshot/restore, QR, health, login and backup.",
  );
} finally {
  server.kill("SIGTERM");
  const timer = setTimeout(() => server.kill("SIGKILL"), 10000);
  await exit;
  clearTimeout(timer);
}
