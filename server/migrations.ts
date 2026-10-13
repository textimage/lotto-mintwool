import type Database from "better-sqlite3";

export interface Migration {
  version: number;
  apply(sql: Database.Database): void;
}

// Applied migrations are immutable. Append the next version for future changes.
export const migrations: readonly Migration[] = [
  {
    version: 1,
    apply(sql) {
      sql.exec(`
        CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, created_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), expires_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS auth_throttles (key TEXT PRIMARY KEY, failures INTEGER NOT NULL, started_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS draws (draw_no INTEGER PRIMARY KEY CHECK(draw_no > 0), draw_date TEXT NOT NULL UNIQUE, payload TEXT NOT NULL, status TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS favorites (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), name TEXT NOT NULL, numbers TEXT NOT NULL, memo TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS tickets (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), draw_no INTEGER NOT NULL, draw_date TEXT NOT NULL, memo TEXT NOT NULL, source TEXT NOT NULL, favorite_id TEXT, qr_fingerprint TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(user_id, qr_fingerprint));
        CREATE INDEX IF NOT EXISTS tickets_owner_date ON tickets(user_id, draw_date DESC);
        CREATE TABLE IF NOT EXISTS games (id TEXT PRIMARY KEY, ticket_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE, position INTEGER NOT NULL, numbers TEXT NOT NULL, quantity INTEGER NOT NULL CHECK(quantity > 0));
        CREATE INDEX IF NOT EXISTS games_ticket ON games(ticket_id, position);
        CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK(id = 1), payload TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS sync_jobs (id TEXT PRIMARY KEY, mode TEXT NOT NULL, status TEXT NOT NULL, total INTEGER NOT NULL DEFAULT 0, processed INTEGER NOT NULL DEFAULT 0, saved INTEGER NOT NULL DEFAULT 0, fallback_count INTEGER NOT NULL DEFAULT 0, errors TEXT NOT NULL DEFAULT '[]', work TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, finished_at TEXT);
        INSERT OR IGNORE INTO settings(id,payload) VALUES(1,'{"autoSync":true}');
      `);
    },
  },
  {
    version: 2,
    apply(sql) {
      const columns = sql.pragma("table_info(tickets)") as { name: string }[];
      if (columns.some((column) => column.name === "total_cost"))
        sql.exec("ALTER TABLE tickets DROP COLUMN total_cost");
    },
  },
  {
    version: 3,
    apply(sql) {
      sql.exec(`
        CREATE TABLE IF NOT EXISTS telegram_state (
          bot_id TEXT PRIMARY KEY, next_update_id INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS telegram_accounts (
          scope TEXT PRIMARY KEY, activated_at INTEGER NOT NULL,
          blocked INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS telegram_updates (
          bot_id TEXT NOT NULL, update_id INTEGER NOT NULL, processed_at INTEGER NOT NULL,
          PRIMARY KEY(bot_id, update_id)
        );
        CREATE TABLE IF NOT EXISTS telegram_outbox (
          id INTEGER PRIMARY KEY AUTOINCREMENT, scope TEXT NOT NULL,
          delivery_key TEXT NOT NULL, part INTEGER NOT NULL, text TEXT NOT NULL,
          sent_at INTEGER, message_id INTEGER, attempts INTEGER NOT NULL DEFAULT 0,
          next_attempt_at INTEGER NOT NULL DEFAULT 0,
          UNIQUE(scope, delivery_key, part)
        );
        CREATE INDEX IF NOT EXISTS telegram_outbox_pending ON telegram_outbox(scope, sent_at, id);
        CREATE TABLE IF NOT EXISTS telegram_reports (
          scope TEXT NOT NULL, draw_no INTEGER NOT NULL, initial_at INTEGER NOT NULL,
          final_queued INTEGER NOT NULL DEFAULT 0, next_refresh_at INTEGER NOT NULL,
          PRIMARY KEY(scope, draw_no)
        );
      `);
    },
  },
];

export function applyMigrations(
  sql: Database.Database,
  definitions: readonly Migration[] = migrations,
): number[] {
  if (definitions.some((migration, index) => migration.version !== index + 1))
    throw new Error("마이그레이션 버전은 1부터 순서대로 지정해야 합니다.");
  sql.exec(
    "CREATE TABLE IF NOT EXISTS migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)",
  );
  const history = sql
    .prepare("SELECT version FROM migrations ORDER BY version")
    .all() as {
    version: number;
  }[];
  if (
    history.some(
      (row, index) =>
        row.version !== index + 1 || row.version > definitions.length,
    )
  )
    throw new Error("DB 마이그레이션 이력이 현재 앱 버전과 호환되지 않습니다.");
  const applied: number[] = [];
  for (const migration of definitions) {
    const changed = sql
      .transaction(() => {
        if (
          sql
            .prepare("SELECT 1 FROM migrations WHERE version=?")
            .get(migration.version)
        )
          return false;
        migration.apply(sql);
        if ((sql.pragma("foreign_key_check") as unknown[]).length)
          throw new Error("마이그레이션 후 외래 키 검증에 실패했습니다.");
        sql
          .prepare(
            "INSERT INTO migrations(version,applied_at) VALUES(?,datetime('now'))",
          )
          .run(migration.version);
        return true;
      })
      .immediate();
    if (changed) applied.push(migration.version);
  }
  return applied;
}
