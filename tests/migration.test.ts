import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { Store } from "../server/db.js";
import { applyMigrations, migrations } from "../server/migrations.js";

test("version 1 migration preserves tickets, games, QR uniqueness and accounts on reopen", () => {
  const directory = mkdtempSync(join(tmpdir(), "lotto-migration-"));
  const path = join(directory, "lotto.sqlite");
  let store: Store | undefined;
  try {
    const legacy = new Database(path);
    legacy.exec(`
      CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE tickets (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), draw_no INTEGER NOT NULL, draw_date TEXT NOT NULL, total_cost INTEGER NOT NULL, memo TEXT NOT NULL, source TEXT NOT NULL, favorite_id TEXT, qr_fingerprint TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(user_id,qr_fingerprint));
      CREATE TABLE games (id TEXT PRIMARY KEY, ticket_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE, position INTEGER NOT NULL, numbers TEXT NOT NULL, quantity INTEGER NOT NULL CHECK(quantity > 0));
      INSERT INTO users VALUES('owner','test-user','preserved-hash','2026-10-01T00:00:00Z');
      INSERT INTO tickets VALUES('ticket','owner',1245,'2026-10-10',2000,'메모','qr',NULL,'qr-fingerprint','2026-10-01T00:00:00Z','2026-10-01T00:00:00Z');
      INSERT INTO games VALUES('game','ticket',0,'[1,2,3,4,5,6]',2);
    `);
    legacy.close();
    store = new Store(path);
    const expected = store.tickets("owner");
    assert.equal(expected.length, 1);
    assert.equal(expected[0].id, "ticket");
    assert.equal(expected[0].memo, "메모");
    assert.equal(expected[0].qrFingerprint, "qr-fingerprint");
    assert.deepEqual(expected[0].games, [
      { id: "game", numbers: [1, 2, 3, 4, 5, 6], quantity: 2 },
    ]);
    assert.ok(
      !(store.sql.pragma("table_info(tickets)") as { name: string }[]).some(
        (c) => c.name === "total_cost",
      ),
    );
    assert.ok(!("totalCost" in expected[0]));
    assert.equal(
      (
        store.sql.prepare("SELECT password_hash FROM users").get() as {
          password_hash: string;
        }
      ).password_hash,
      "preserved-hash",
    );
    assert.deepEqual(store.sql.pragma("foreign_key_check"), []);
    assert.equal(
      (
        store.sql
          .prepare("SELECT COUNT(*) AS count FROM migrations WHERE version=3")
          .get() as { count: number }
      ).count,
      1,
    );
    for (const name of [
      "telegram_state",
      "telegram_accounts",
      "telegram_updates",
      "telegram_outbox",
      "telegram_reports",
    ])
      assert.ok(
        store.sql
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
          )
          .get(name),
      );
    assert.throws(() => store!.saveTicket("owner", expected[0]), /UNIQUE/);
    assert.deepEqual(store.tickets("owner"), expected);
    store.close();
    store = new Store(path);
    assert.deepEqual(store.tickets("owner"), expected);
    assert.equal(
      (
        store.sql
          .prepare("SELECT COUNT(*) AS count FROM migrations WHERE version=2")
          .get() as { count: number }
      ).count,
      1,
    );
    store.deleteTicket("ticket", "owner");
    assert.equal(
      (
        store.sql.prepare("SELECT COUNT(*) AS count FROM games").get() as {
          count: number;
        }
      ).count,
      0,
    );
  } finally {
    store?.close();
    if (
      dirname(resolve(directory)) === resolve(tmpdir()) &&
      basename(directory).startsWith("lotto-migration-")
    )
      rmSync(directory, { recursive: true, force: true });
  }
});

test("pending migrations are applied once and a failed version rolls back its changes and history", () => {
  const sql = new Database(":memory:");
  try {
    sql.pragma("foreign_keys = ON");
    assert.deepEqual(applyMigrations(sql), [1, 2, 3]);
    sql
      .prepare("INSERT INTO users VALUES(?,?,?,?)")
      .run("owner", "user", "hash", "date");
    const before = sql.prepare("SELECT * FROM migrations").all();
    let called = 0;
    const broken = [
      ...migrations,
      {
        version: 4,
        apply(db: Database.Database) {
          called++;
          db.exec(
            "CREATE TABLE new_feature(id INTEGER); UPDATE users SET password_hash='changed'",
          );
          throw new Error("migration failed for test");
        },
      },
    ];
    assert.throws(
      () => applyMigrations(sql, broken),
      /migration failed for test/,
    );
    assert.equal(called, 1);
    assert.equal(
      sql
        .prepare("SELECT name FROM sqlite_master WHERE name='new_feature'")
        .get(),
      undefined,
    );
    assert.deepEqual(sql.prepare("SELECT * FROM migrations").all(), before);
    assert.equal(
      (
        sql.prepare("SELECT password_hash FROM users").get() as {
          password_hash: string;
        }
      ).password_hash,
      "hash",
    );
    const repaired = [
      ...migrations,
      {
        version: 4,
        apply(db: Database.Database) {
          db.exec("CREATE TABLE new_feature(id INTEGER)");
        },
      },
    ];
    assert.deepEqual(applyMigrations(sql, repaired), [4]);
    assert.deepEqual(applyMigrations(sql, repaired), []);
    assert.throws(() => applyMigrations(sql), /현재 앱 버전/);
  } finally {
    sql.close();
  }
});

test("a versioned database keeps settings and applied versions are not executed again", () => {
  const sql = new Database(":memory:");
  try {
    applyMigrations(sql);
    sql.prepare("UPDATE settings SET payload=?").run('{"autoSync":false}');
    const forbidden = migrations.map((migration) => ({
      version: migration.version,
      apply() {
        throw new Error("Already applied migration ran again");
      },
    }));
    assert.deepEqual(applyMigrations(sql, forbidden), []);
    assert.equal(
      (sql.prepare("SELECT payload FROM settings").get() as { payload: string })
        .payload,
      '{"autoSync":false}',
    );
    assert.equal(sql.pragma("quick_check", { simple: true }), "ok");
  } finally {
    sql.close();
  }
});
