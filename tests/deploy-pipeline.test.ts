import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  copyFileSync,
  writeFileSync,
  readFileSync,
  existsSync,
  symlinkSync,
  readlinkSync,
  rmSync,
  rmdirSync,
  statSync,
  lstatSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";

// Real POSIX shell + real flock + mocked network/Docker, with actual temporary SQLite files.
const linuxOnly =
  process.platform !== "linux"
    ? "Deployment scripts require Linux; run the source Docker target to verify them."
    : false;
const managedFixtureOnly = linuxOnly ||
  (process.env.MINTWOOL_MANAGED_FIXTURE === "1" && existsSync("/.dockerenv") && process.getuid?.() === 0
    ? false
    : "Managed deployment directory tests require an explicitly enabled disposable root Docker container.");
const bootstrap =
  "APP_DOMAIN=lotto.mintwool.com\nBOOTSTRAP_PASSWORD_HASH='scrypt$v1$testSalt$testKey'\nTELEGRAM_ENABLED=false\n";
type Call = { tool: string; args: string[]; image: string };

function fixture(previous = true, managedRoot?: string) {
  const root = managedRoot ?? mkdtempSync(join(tmpdir(), "lotto-pipeline-"));
  const candidate = join(root, "releases", "new");
  const bin = join(root, "bin");
  mkdirSync(candidate, { recursive: true });
  mkdirSync(bin);
  for (const file of ["compose.yaml", "Dockerfile", "Caddyfile"])
    copyFileSync(resolve(file), join(candidate, file));
  writeFileSync(join(candidate, ".env.bootstrap"), bootstrap);
  if (previous) {
    const old = join(root, "releases", "old");
    mkdirSync(old);
    copyFileSync(resolve("compose.yaml"), join(old, "compose.yaml"));
    writeFileSync(join(old, ".release-domain"), "lotto.mintwool.com\n");
    writeFileSync(join(old, ".release-proxy"), "caddy\n");
    writeFileSync(join(root, ".env"), bootstrap + "KEEP=server-only\n");
    symlinkSync(join(root, ".env"), join(old, ".env"));
    symlinkSync("releases/old", join(root, "current"));
    mkdirSync(join(root, "data"));
    const sql = new Database(join(root, "data", "lotto.sqlite"));
    sql.exec(
      "CREATE TABLE records(id TEXT PRIMARY KEY, value TEXT); INSERT INTO records VALUES('personal','original')",
    );
    sql.close();
    writeFileSync(join(root, "running"), "lotto-note:old");
  }
  const helper = join(root, "mock.mjs");
  writeFileSync(
    helper,
    `
import { appendFileSync, existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync, copyFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import Database from ${JSON.stringify(pathToFileURL(resolve("node_modules/better-sqlite3/lib/index.js")).href)};
import { spawnSync } from 'node:child_process';
const [tool, ...args] = process.argv.slice(2);
const root = process.env.MOCK_ROOT;
const fault = process.env.MOCK_FAIL || '';
const image = process.env.APP_IMAGE || '';
const running = join(root, 'running');
const db = join(root, 'data', 'lotto.sqlite');
appendFileSync(join(root, 'calls.jsonl'), JSON.stringify({ tool, args, image }) + '\\n');
const isNew = image === 'lotto-note:new';
if (process.env.MOCK_EXPECT_SHARED_RELEASE === '1' && !existsSync(join(root, 'shared-released'))) process.exit(95);
if (tool === 'sleep') process.exit(0);
if (tool === 'curl') {
  const url = args.at(-1);
  const active = existsSync(running) ? readFileSync(running, 'utf8') : '';
  process.exit(active === 'lotto-note:new' && ((fault === 'health' && url.startsWith('http:')) || (fault === 'https' && url.startsWith('https:'))) ? 1 : 0);
}
if (tool === 'ssh') {
  if (process.env.MOCK_SSH_PREFLIGHT === '1') process.exit(spawnSync('sh', ['-c', args.at(-1)], { stdio: 'inherit' }).status ?? 1);
  process.exit(0);
}
if (tool === 'scp') {
  const source = args.at(-2);
  copyFileSync(source, join(root, basename(source) === 'source.tar.gz' ? 'uploaded.tar.gz' : 'uploaded.env'));
  process.exit(0);
}
if (args[0] === 'inspect') { console.log('healthy'); process.exit(0); }
if (args[0] === 'image' || args[0] === 'rm') process.exit(0);
const command = args.find((value) => ['config','build','pull','run','stop','up','ps','port','exec','logs'].includes(value));
if (command === 'config') process.exit(fault === 'config' ? 1 : 0);
if (command === 'build' || command === 'pull') process.exit(fault === command ? 1 : 0);
if (command === 'ps') {
  if (existsSync(running)) console.log(args.includes('--services') ? 'app' : 'test-container');
  process.exit(0);
}
if (command === 'port') { console.log('127.0.0.1:3000'); process.exit(0); }
if (command === 'stop') { if (existsSync(running)) unlinkSync(running); process.exit(0); }
if (command === 'exec' || command === 'logs') process.exit(0);
if (command === 'up') {
  writeFileSync(running, image);
  if (isNew) {
    const sql = new Database(db);
    sql.exec("INSERT OR REPLACE INTO records VALUES('startup','new-runtime-record')");
    sql.close();
  }
  process.exit(isNew && fault === 'start' ? 1 : 0);
}
if (command === 'run') {
  if (args.some((value) => value.endsWith('telegram-qr-check.js'))) process.exit(fault === 'qr' ? 1 : 0);
  const offset = args.findIndex((value) => value.endsWith('maintenance.js'));
  const operation = args[offset + 1];
  const backup = join(root, 'backups', basename(args[offset + 2] || 'none'));
  if (operation === 'snapshot') {
    if (fault === 'backup') process.exit(1);
    if (!existsSync(db)) process.exit(3);
    mkdirSync(join(root, 'backups'), { recursive: true });
    const sql = new Database(db);
    await sql.backup(backup);
    sql.close();
  } else if (operation === 'restore') {
    if (fault === 'migrate-restore') process.exit(1);
    copyFileSync(backup, db);
  } else if (operation === 'migrate') {
    mkdirSync(join(root, 'data'), { recursive: true });
    const sql = new Database(db);
    sql.exec("CREATE TABLE IF NOT EXISTS records(id TEXT PRIMARY KEY,value TEXT); INSERT OR REPLACE INTO records VALUES('personal','migrated'); CREATE TABLE added_by_migration(id INTEGER)");
    sql.close();
    if (fault.startsWith('migrate')) process.exit(1);
  } else process.exit(2);
  process.exit(0);
}
process.exit(2);
`,
  );
  for (const tool of ["docker", "curl", "sleep", "ssh", "scp"])
    writeFileSync(
      join(bin, tool),
      `#!/bin/sh\nexec '${process.execPath}' '${helper}' '${tool}' "$@"\n`,
      { mode: 0o755 },
    );
  return {
    root,
    candidate,
    run(fault = "", proxy = "caddy", sharedLock = "", extraEnv = {}, deployRoot = root) {
      return spawnSync(
        "sh",
        [
          resolve("scripts/deploy.sh"),
          "lotto.mintwool.com",
          proxy,
          deployRoot,
          "new",
          sharedLock,
        ],
        {
          cwd: candidate,
          env: {
            ...process.env,
            PATH: `${bin}:${process.env.PATH}`,
            MOCK_ROOT: root,
            MOCK_FAIL: fault,
            ...extraEnv,
          },
          encoding: "utf8",
          timeout: 30000,
        },
      );
    },
    calls(): Call[] {
      return readFileSync(join(root, "calls.jsonl"), "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Call);
    },
    records() {
      const sql = new Database(join(root, "data", "lotto.sqlite"));
      try {
        return sql.prepare("SELECT * FROM records ORDER BY id").all();
      } finally {
        sql.close();
      }
    },
    bin,
    cleanup() {
      if (managedRoot) assert.equal(root, "/opt/mintwool/lotto");
      else assert.equal(dirname(root), resolve(tmpdir()));
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test(
  "managed Lotto root activates normally and rejects shared roots, sibling apps, and symlink aliases before env or DB changes",
  { skip: managedFixtureOnly },
  (t) => {
    // This fixture owns the managed parent only when it did not already exist.
    const managedParent = "/opt/mintwool";
    if (existsSync(managedParent)) { t.skip("Existing managed server directory must not be touched by tests."); return; }
    mkdirSync(managedParent);
    const f = fixture(true, join(managedParent, "lotto"));
    const sibling = join(managedParent, "tools");
    const alias = join(tmpdir(), `lotto-alias-${process.pid}`);
    const redirectedSibling = mkdtempSync(join(tmpdir(), "lotto-sibling-"));
    try {
      mkdirSync(sibling);
      symlinkSync(sibling, alias);
      for (const root of [managedParent, sibling, `${sibling}/nested`, `${f.root}/releases/new`, alias]) {
        const result = f.run("", "existing", "", {}, root);
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /Managed Lotto directory/);
        assert.ok(!existsSync(join(f.root, "calls.jsonl")));
        assert.ok(existsSync(join(f.candidate, ".env.bootstrap")));
        assert.equal(readFileSync(join(f.root, ".env"), "utf8"), bootstrap + "KEEP=server-only\n");
        assert.deepEqual(f.records(), [{ id: "personal", value: "original" }]);
      }
      const aliasUpload = spawnSync("bash", [resolve("scripts/upload-deploy.sh")], {
        env: {
          ...process.env, PATH: `${f.bin}:${process.env.PATH}`, MOCK_ROOT: f.root, MOCK_SSH_PREFLIGHT: "1",
          OCI_HOST: "example.test", OCI_USERNAME: "ubuntu", OCI_SSH_PRIVATE_KEY: "test-private-key",
          OCI_SSH_KNOWN_HOSTS: "example.test ssh-ed25519 test", OCI_ENV_BOOTSTRAP: bootstrap,
          RELEASE_ID: "test-alias-root", OCI_DEPLOY_DIR: alias,
        },
        encoding: "utf8", timeout: 10000,
      });
      assert.notEqual(aliasUpload.status, 0);
      assert.match(aliasUpload.stderr, /Managed Lotto directory/);
      assert.equal(f.calls().length, 1);
      assert.equal(f.calls()[0].tool, "ssh");
      assert.ok(!existsSync(join(sibling, "releases")));
      assert.ok(!existsSync(join(f.root, "uploaded.env")));
      assert.deepEqual(f.records(), [{ id: "personal", value: "original" }]);
      rmSync(alias);
      rmdirSync(sibling);
      symlinkSync(redirectedSibling, sibling);
      symlinkSync(sibling, alias);
      const redirected = f.run("", "existing", "", {}, alias);
      assert.notEqual(redirected.status, 0);
      assert.match(redirected.stderr, /Managed Lotto directory/);
      assert.ok(!existsSync(join(redirectedSibling, ".env")));
      assert.equal(f.calls().length, 1);
      const result = f.run("", "existing");
      assert.equal(result.status, 0, result.stderr);
      assert.equal(readlinkSync(join(f.root, "current")), "releases/new");
      assert.equal(readFileSync(join(f.root, ".env"), "utf8"), bootstrap + "KEEP=server-only\n");
    } finally {
      rmSync(alias, { force: true });
      if (lstatSync(sibling).isSymbolicLink()) rmSync(sibling);
      else rmdirSync(sibling);
      rmdirSync(redirectedSibling);
      f.cleanup();
      rmdirSync(managedParent);
    }
  },
);

test(
  "upload preflight refuses a symlink at the own managed path before creating releases or transferring configuration",
  { skip: managedFixtureOnly },
  (t) => {
    const managedParent = "/opt/mintwool";
    if (existsSync(managedParent)) { t.skip("Existing managed server directory must not be touched by tests."); return; }
    const f = fixture(false);
    const alias = join(managedParent, "lotto");
    mkdirSync(managedParent);
    symlinkSync(f.root, alias);
    try {
      const result = spawnSync("bash", [resolve("scripts/upload-deploy.sh")], {
        env: {
          ...process.env, PATH: `${f.bin}:${process.env.PATH}`, MOCK_ROOT: f.root, MOCK_SSH_PREFLIGHT: "1",
          OCI_HOST: "example.test", OCI_USERNAME: "ubuntu", OCI_SSH_PRIVATE_KEY: "test-private-key",
          OCI_SSH_KNOWN_HOSTS: "example.test ssh-ed25519 test", OCI_ENV_BOOTSTRAP: bootstrap,
          RELEASE_ID: "test-symlink-root", OCI_DEPLOY_DIR: alias,
        },
        encoding: "utf8", timeout: 10000,
      });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /must not contain symlinks/);
      assert.equal(f.calls().length, 1);
      assert.equal(f.calls()[0].tool, "ssh");
      assert.ok(!existsSync(join(f.root, "uploaded.env")));
      assert.ok(!existsSync(join(f.root, ".env")));
      assert.ok(!existsSync(join(f.root, "releases", "test-symlink-root")));
    } finally {
      rmSync(alias);
      rmdirSync(managedParent);
      f.cleanup();
    }
  },
);

test(
  "upload refuses managed shared and sibling paths before any SSH or file transfer",
  { skip: linuxOnly },
  () => {
    const f = fixture(false);
    try {
      for (const root of ["/opt/mintwool", "/opt/mintwool/tools", "/opt/mintwool/tools/nested", "/opt/mintwool/lotto/releases"]) {
        const result = spawnSync("bash", [resolve("scripts/upload-deploy.sh")], {
          env: {
            ...process.env, PATH: `${f.bin}:${process.env.PATH}`, MOCK_ROOT: f.root,
            OCI_HOST: "example.test", OCI_USERNAME: "ubuntu", OCI_SSH_PRIVATE_KEY: "test-private-key",
            OCI_SSH_KNOWN_HOSTS: "example.test ssh-ed25519 test", RELEASE_ID: "test-invalid-root", OCI_DEPLOY_DIR: root,
          },
          encoding: "utf8", timeout: 5000,
        });
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /Managed Lotto directory/);
        assert.ok(!existsSync(join(f.root, "calls.jsonl")));
        assert.ok(!existsSync(join(f.root, "uploaded.env")));
      }
    } finally { f.cleanup(); }
  },
);

test(
  "deployment builds and checks QR before stopping, snapshots before migration, then activates a release",
  { skip: linuxOnly },
  () => {
    const f = fixture();
    try {
      const result = f.run();
      assert.equal(result.status, 0, result.stderr);
      assert.equal(readlinkSync(join(f.root, "current")), "releases/new");
      assert.equal(readlinkSync(join(f.root, "previous")), "releases/old");
      const calls = f.calls();
      const index = (arg: string) =>
        calls.findIndex((call) =>
          call.args.some((value) => value.endsWith(arg)),
        );
      assert.ok(index("build") < index("telegram-qr-check.js"));
      assert.ok(index("telegram-qr-check.js") < index("stop"));
      assert.ok(index("stop") < index("snapshot"));
      assert.ok(index("snapshot") < index("migrate"));
      assert.ok(index("migrate") < index("up"));
      assert.ok(
        calls.some(
          (call) =>
            call.tool === "curl" && call.args.at(-1)?.startsWith("https:"),
        ),
      );
      assert.equal(
        readFileSync(join(f.root, ".env"), "utf8"),
        bootstrap + "KEEP=server-only\n",
      );
      assert.ok(!existsSync(join(f.candidate, ".env.bootstrap")));
      assert.equal(statSync(join(f.root, ".env")).mode & 0o777, 0o600);
    } finally {
      f.cleanup();
    }
  },
);

for (const fault of ["build", "pull", "qr"]) {
  test(
    `${fault} failure leaves the previous app and DB running`,
    { skip: linuxOnly },
    () => {
      const f = fixture();
      try {
        const result = f.run(fault);
        assert.notEqual(result.status, 0);
        assert.equal(
          readFileSync(join(f.root, "running"), "utf8"),
          "lotto-note:old",
        );
        assert.deepEqual(f.records(), [{ id: "personal", value: "original" }]);
        assert.ok(
          !f
            .calls()
            .some(
              (call) =>
                call.args.includes("stop") || call.args.includes("migrate"),
            ),
        );
      } finally {
        f.cleanup();
      }
    },
  );
}

test(
  "backup failure resumes the previous app without attempting a migration or restore",
  { skip: linuxOnly },
  () => {
    const f = fixture();
    try {
      const result = f.run("backup");
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /previous_app_resumed/);
      assert.equal(
        readFileSync(join(f.root, "running"), "utf8"),
        "lotto-note:old",
      );
      assert.deepEqual(f.records(), [{ id: "personal", value: "original" }]);
      assert.ok(
        !f
          .calls()
          .some(
            (call) =>
              call.args.includes("migrate") || call.args.includes("restore"),
          ),
      );
    } finally {
      f.cleanup();
    }
  },
);

test(
  "migration failure restores the schema and records and resumes the previous image while returning failure",
  { skip: linuxOnly },
  () => {
    const f = fixture();
    try {
      const result = f.run("migrate");
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /rollback_completed/);
      assert.equal(readlinkSync(join(f.root, "current")), "releases/old");
      assert.equal(
        readFileSync(join(f.root, "running"), "utf8"),
        "lotto-note:old",
      );
      assert.deepEqual(f.records(), [{ id: "personal", value: "original" }]);
      const sql = new Database(join(f.root, "data", "lotto.sqlite"));
      assert.equal(
        sql
          .prepare(
            "SELECT name FROM sqlite_master WHERE name='added_by_migration'",
          )
          .get(),
        undefined,
      );
      sql.close();
      assert.ok(
        f
          .calls()
          .some(
            (call) =>
              call.args.includes("up") && call.image === "lotto-note:old",
          ),
      );
    } finally {
      f.cleanup();
    }
  },
);

test(
  "failed restore reports recovery failure and keeps the app stopped",
  { skip: linuxOnly },
  () => {
    const f = fixture();
    try {
      const result = f.run("migrate-restore");
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /rollback_failed/);
      assert.ok(!existsSync(join(f.root, "running")));
      assert.ok(!f.calls().some((call) => call.args.includes("up")));
    } finally {
      f.cleanup();
    }
  },
);

for (const fault of ["start", "health", "https"]) {
  test(
    `${fault} failure after startup preserves new records and stops the app`,
    { skip: linuxOnly },
    () => {
      const f = fixture();
      try {
        const result = f.run(fault);
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /database_preserved/);
        assert.ok(!existsSync(join(f.root, "running")));
        assert.ok(!f.calls().some((call) => call.args.includes("restore")));
        assert.deepEqual(f.records(), [
          { id: "personal", value: "migrated" },
          { id: "startup", value: "new-runtime-record" },
        ]);
      } finally {
        f.cleanup();
      }
    },
  );
}

test(
  "first deployment creates the initial env literally and tolerates a missing database",
  { skip: linuxOnly },
  () => {
    const f = fixture(false);
    try {
      const result = f.run();
      assert.equal(result.status, 0, result.stderr);
      assert.equal(readFileSync(join(f.root, ".env"), "utf8"), bootstrap);
      assert.ok(!existsSync(join(f.root, "backups", "deploy-new.sqlite")));
      assert.equal(readlinkSync(join(f.root, "current")), "releases/new");
      assert.ok(!result.stdout.includes("scrypt$v1"));
    } finally {
      f.cleanup();
    }
  },
);

test(
  "first migration failure preserves the new DB and does not invent a previous release",
  { skip: linuxOnly },
  () => {
    const f = fixture(false);
    try {
      const result = f.run("migrate");
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /first_deployment_database_preserved/);
      assert.ok(!existsSync(join(f.root, "current")));
      assert.ok(!existsSync(join(f.root, "running")));
      assert.deepEqual(f.records(), [{ id: "personal", value: "migrated" }]);
    } finally {
      f.cleanup();
    }
  },
);

test(
  "existing proxy mode starts only the app and still verifies HTTPS",
  { skip: linuxOnly },
  () => {
    const f = fixture();
    try {
      const result = f.run("", "existing");
      assert.equal(result.status, 0, result.stderr);
      const calls = f.calls();
      assert.ok(
        calls.find((call) => call.args.includes("up"))?.args.at(-1) === "app",
      );
      assert.ok(!calls.some((call) => call.args.includes("caddy")));
      assert.ok(
        calls.some(
          (call) =>
            call.tool === "curl" && call.args.at(-1)?.startsWith("https:"),
        ),
      );
    } finally {
      f.cleanup();
    }
  },
);

test(
  "a real held deployment lock rejects another deployment before changing env or DB",
  { skip: linuxOnly },
  async () => {
    const f = fixture();
    const lock = spawn(
      "flock",
      [
        "--no-fork",
        join(f.root, ".deploy.lock"),
        "sh",
        "-c",
        "printf 'locked\\n'; read -r line",
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    try {
      await new Promise<void>((resolveReady, reject) => {
        const timer = setTimeout(
          () => reject(new Error("Lock was not acquired")),
          5000,
        );
        lock.stdout.once("data", () => {
          clearTimeout(timer);
          resolveReady();
        });
        lock.once("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
      });
      const result = f.run();
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /Another deployment/);
      assert.ok(existsSync(join(f.candidate, ".env.bootstrap")));
      assert.deepEqual(f.records(), [{ id: "personal", value: "original" }]);
    } finally {
      lock.stdin.end("release\n");
      await new Promise<void>((done) => lock.once("close", () => done()));
      f.cleanup();
    }
  },
);

test(
  "upload requires strict host verification and packages source without secrets or generated state",
  { skip: linuxOnly },
  () => {
    const f = fixture(false);
    try {
      const result = spawnSync("bash", [resolve("scripts/upload-deploy.sh")], {
        env: {
          ...process.env,
          PATH: `${f.bin}:${process.env.PATH}`,
          MOCK_ROOT: f.root,
          OCI_HOST: "example.test",
          OCI_USERNAME: "deploy_user",
          OCI_SSH_PRIVATE_KEY: "test-private-key",
          OCI_SSH_KNOWN_HOSTS: "example.test ssh-ed25519 test",
          OCI_SSH_PORT: "2222",
          OCI_DEPLOY_DIR: "/opt/lotto-note-ci",
          APP_DOMAIN: "lotto.example.test",
          OCI_ENV_BOOTSTRAP: bootstrap,
          RELEASE_ID: "test-upload",
          OCI_DEPLOY_LOCK_FILE: "/opt/mintwool/deploy.lock",
        },
        encoding: "utf8",
        timeout: 30000,
      });
      assert.equal(result.status, 0, result.stderr);
      const calls = f
        .calls()
        .filter((call) => call.tool === "ssh" || call.tool === "scp");
      assert.ok(calls.length >= 4);
      assert.ok(calls.every((call) => call.args.includes("2222")));
      assert.ok(calls.some((call) => call.tool === "ssh" && call.args.includes("deploy_user@example.test")));
      assert.ok(calls.some((call) => call.tool === "ssh" && call.args.at(-1)?.includes("scripts/deploy.sh 'lotto.example.test' 'existing' '/opt/lotto-note-ci'")));
      assert.ok(calls.some((call) => call.tool === "ssh" && call.args.at(-1)?.includes("'/opt/mintwool/deploy.lock'")));
      assert.ok(
        calls.every(
          (call) =>
            call.args.includes("StrictHostKeyChecking=yes") &&
            call.args.includes("IdentitiesOnly=yes"),
        ),
      );
      const archive = spawnSync(
        "tar",
        ["-tzf", join(f.root, "uploaded.tar.gz")],
        { encoding: "utf8" },
      );
      assert.equal(archive.status, 0);
      const entries = archive.stdout.trim().split("\n");
      assert.ok(entries.includes(".env.example"));
      assert.ok(
        !entries.some((entry) =>
          /^(\.env$|\.env\.bootstrap$|data\/|backups\/|dist\/|node_modules\/|\.git\/|\.tmp\/)/.test(
            entry,
          ),
        ),
      );
      assert.equal(
        readFileSync(join(f.root, "uploaded.env"), "utf8"),
        bootstrap + "\n",
      );
      assert.ok(
        !result.stdout.includes("test-private-key") &&
          !result.stdout.includes("scrypt$v1"),
      );
    } finally {
      f.cleanup();
    }
  },
);

test(
  "upload rejects legacy setting names before transmitting source or secrets",
  { skip: linuxOnly },
  () => {
    const f = fixture(false);
    try {
      const env = {
        ...process.env,
        PATH: `${f.bin}:${process.env.PATH}`,
        MOCK_ROOT: f.root,
        OCI_HOST: "example.test",
        OCI_USER: "legacy-user",
        OCI_KNOWN_HOSTS: "example.test ssh-ed25519 legacy",
        OCI_USERNAME: "",
        OCI_SSH_KNOWN_HOSTS: "",
        OCI_SSH_PRIVATE_KEY: "test-private-key",
        RELEASE_ID: "test-legacy",
      };
      for (const [settings, missing] of [
        [env, "OCI_USERNAME"],
        [{ ...env, OCI_USERNAME: "ubuntu" }, "OCI_SSH_KNOWN_HOSTS"],
      ] as const) {
        const result = spawnSync("bash", [resolve("scripts/upload-deploy.sh")], {
          env: settings, encoding: "utf8", timeout: 5000,
        });
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, new RegExp(missing));
        assert.ok(!existsSync(join(f.root, "uploaded.tar.gz")));
        assert.ok(!existsSync(join(f.root, "uploaded.env")));
        assert.ok(!result.stderr.includes("test-private-key"));
      }
    } finally {
      f.cleanup();
    }
  },
);

test(
  "a real shared server lock queues deployment until another application releases it",
  { skip: linuxOnly },
  async () => {
    const f = fixture();
    const sharedLock = join(f.root, "shared.lock");
    writeFileSync(sharedLock, "");
    const lock = spawn("flock", ["--no-fork", sharedLock, "sh", "-c",
      "printf 'locked\\n'; sleep 1; printf 'released\\n' > \"$1/shared-released\"", "sh", f.root],
      { stdio: ["ignore", "pipe", "pipe"] });
    const closed = new Promise<void>((done) => lock.once("close", () => done()));
    try {
      await new Promise<void>((ready, reject) => {
        const timer = setTimeout(() => reject(new Error("Shared lock was not acquired")), 5000);
        lock.stdout.once("data", () => { clearTimeout(timer); ready(); });
        lock.once("error", (error) => { clearTimeout(timer); reject(error); });
      });
      const result = f.run("", "existing", sharedLock, { MOCK_EXPECT_SHARED_RELEASE: "1" });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /Waiting for shared server deployment lock/);
      assert.ok(existsSync(join(f.root, "shared-released")));
      assert.ok(f.calls().some((call) => call.args.includes("build")));
    } finally {
      if (lock.exitCode === null) lock.kill();
      await closed;
      f.cleanup();
    }
  },
);

test(
  "a missing shared lock is rejected before configuration or data changes",
  { skip: linuxOnly },
  () => {
    const f = fixture();
    try {
      const result = f.run("", "existing", join(f.root, "missing.lock"));
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /Prepare the shared deployment lock/);
      assert.ok(existsSync(join(f.candidate, ".env.bootstrap")));
      assert.deepEqual(f.records(), [{ id: "personal", value: "original" }]);
      assert.ok(!existsSync(join(f.root, "calls.jsonl")));
    } finally { f.cleanup(); }
  },
);
