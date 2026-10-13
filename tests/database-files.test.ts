import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { snapshotDatabase, restoreDatabase } from "../server/database-files.js";
import { Store } from "../server/db.js";

function temporary() {
  const root = mkdtempSync(join(tmpdir(), "lotto-db-files-"));
  return {
    root,
    db: join(root, "lotto.sqlite"),
    backup: join(root, "backups", "deploy-test.sqlite"),
    cleanup() {
      assert.equal(dirname(root), resolve(tmpdir()));
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("snapshot includes committed WAL records without migrating and restore preserves the replaced DB", async () => {
  const files = temporary();
  let legacy: Database.Database | undefined;
  try {
    legacy = new Database(files.db);
    legacy.pragma("journal_mode=WAL");
    legacy.pragma("wal_autocheckpoint=0");
    legacy.exec(
      "CREATE TABLE legacy(id INTEGER PRIMARY KEY, total_cost INTEGER); INSERT INTO legacy VALUES(1,2000)",
    );
    assert.ok(existsSync(`${files.db}-wal`));
    assert.equal(await snapshotDatabase(files.db, files.backup), true);
    const snapshot = new Database(files.backup);
    assert.deepEqual(snapshot.prepare("SELECT * FROM legacy").all(), [
      { id: 1, total_cost: 2000 },
    ]);
    assert.equal(
      snapshot
        .prepare("SELECT name FROM sqlite_master WHERE name='migrations'")
        .get(),
      undefined,
    );
    snapshot.close();
    legacy.exec(
      "ALTER TABLE legacy ADD COLUMN changed TEXT; UPDATE legacy SET total_cost=5000",
    );
    legacy.close();
    legacy = undefined;
    const preserved = await restoreDatabase(files.db, files.backup);
    assert.ok(preserved && existsSync(preserved));
    const restored = new Database(files.db);
    assert.deepEqual(restored.prepare("SELECT * FROM legacy").all(), [
      { id: 1, total_cost: 2000 },
    ]);
    assert.equal(restored.pragma("quick_check", { simple: true }), "ok");
    assert.equal(
      restored
        .prepare("SELECT name FROM sqlite_master WHERE name='migrations'")
        .get(),
      undefined,
    );
    restored.close();
    const replaced = new Database(preserved!);
    assert.equal(
      (
        replaced.prepare("SELECT total_cost FROM legacy").get() as {
          total_cost: number;
        }
      ).total_cost,
      5000,
    );
    replaced.close();
  } finally {
    legacy?.close();
    files.cleanup();
  }
});

test("snapshot never overwrites a backup; invalid restore keeps the current DB", async () => {
  const files = temporary();
  try {
    const store = new Store(files.db);
    store.sql
      .prepare("INSERT INTO users VALUES(?,?,?,?)")
      .run("owner", "user", "preserved-hash", "date");
    store.close();
    await snapshotDatabase(files.db, files.backup);
    await assert.rejects(snapshotDatabase(files.db, files.backup), /덮어쓸/);
    const invalid = join(files.root, "invalid.sqlite");
    writeFileSync(invalid, "this is not sqlite");
    await assert.rejects(restoreDatabase(files.db, invalid));
    const unchanged = new Store(files.db);
    assert.equal(
      (
        unchanged.sql.prepare("SELECT password_hash FROM users").get() as {
          password_hash: string;
        }
      ).password_hash,
      "preserved-hash",
    );
    unchanged.close();
  } finally {
    files.cleanup();
  }
});

test("restore refuses a live WAL connection", async () => {
  const files = temporary();
  let store: Store | undefined;
  try {
    store = new Store(files.db);
    await snapshotDatabase(files.db, files.backup);
    await assert.rejects(
      restoreDatabase(files.db, files.backup),
      /WAL 연결|사용 중/,
    );
    assert.equal(store.sql.pragma("quick_check", { simple: true }), "ok");
  } finally {
    store?.close();
    files.cleanup();
  }
});

test("maintenance snapshot exit code distinguishes a fresh volume and never creates a DB", () => {
  const files = temporary();
  try {
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        resolve("server/maintenance.ts"),
        "snapshot",
        files.backup,
      ],
      {
        env: {
          ...process.env,
          DOTENV_CONFIG_PATH: join(files.root, "absent.env"),
          DATA_DIR: files.root,
        },
        encoding: "utf8",
        timeout: 15000,
      },
    );
    assert.equal(result.status, 3, result.stderr);
    assert.ok(!existsSync(files.db));
    assert.ok(!existsSync(files.backup));
    assert.match(result.stdout, /snapshot_missing/);
  } finally {
    files.cleanup();
  }
});

test("migrate CLI creates the schema without bootstrapping an account or starting integrations", () => {
  const files = temporary();
  try {
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", resolve("server/maintenance.ts"), "migrate"],
      {
        env: {
          ...process.env,
          DOTENV_CONFIG_PATH: join(files.root, "absent.env"),
          DATA_DIR: files.root,
          TELEGRAM_ENABLED: "true",
          BOOTSTRAP_PASSWORD_HASH: "",
        },
        encoding: "utf8",
        timeout: 15000,
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /migration_completed/);
    const sql = new Database(files.db);
    assert.equal(
      (
        sql.prepare("SELECT COUNT(*) AS count FROM users").get() as {
          count: number;
        }
      ).count,
      0,
    );
    assert.equal(
      (
        sql.prepare("SELECT COUNT(*) AS count FROM migrations").get() as {
          count: number;
        }
      ).count,
      3,
    );
    sql.close();
  } finally {
    files.cleanup();
  }
});
