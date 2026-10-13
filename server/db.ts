import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { applyMigrations } from "./migrations.js";
import { numberCombinationKey, validateNumbers } from "../shared/domain.js";
import type {
  Draw,
  Favorite,
  PurchaseTicket,
  Settings,
  SyncJob,
  EnsureFavoriteResponse,
} from "../shared/domain.js";

export class FavoriteDuplicateError extends Error {
  constructor() {
    super("이미 나의 번호에 저장된 조합입니다. 기존 항목을 수정해 주세요.");
    this.name = "FavoriteDuplicateError";
  }
}

export class Store {
  readonly sql: Database.Database;
  constructor(filename: string) {
    if (filename !== ":memory:")
      mkdirSync(dirname(filename), { recursive: true });
    this.sql = new Database(filename);
    try {
      this.sql.pragma("busy_timeout = 5000");
      this.sql.pragma("journal_mode = WAL");
      this.sql.pragma("foreign_keys = ON");
      applyMigrations(this.sql);
    } catch (error) {
      this.sql.close();
      throw error;
    }
  }
  close() {
    this.sql.close();
  }
  bootstrap(username: string, passwordHash?: string) {
    const count = (
      this.sql.prepare("SELECT COUNT(*) AS count FROM users").get() as {
        count: number;
      }
    ).count;
    if (count) return;
    if (!passwordHash)
      throw new Error(
        "초기 계정이 없습니다. 먼저 npm run setup:admin을 실행해 주세요.",
      );
    this.sql
      .prepare("INSERT INTO users VALUES(?,?,?,?)")
      .run(randomUUID(), username, passwordHash, new Date().toISOString());
  }
  settings(): Settings {
    return JSON.parse(
      (
        this.sql.prepare("SELECT payload FROM settings WHERE id=1").get() as {
          payload: string;
        }
      ).payload,
    );
  }
  saveSettings(settings: Settings) {
    this.sql
      .prepare("UPDATE settings SET payload=? WHERE id=1")
      .run(JSON.stringify(settings));
  }
  draw(no: number): Draw | undefined {
    const row = this.sql
      .prepare("SELECT payload FROM draws WHERE draw_no=?")
      .get(no) as { payload: string } | undefined;
    return row ? JSON.parse(row.payload) : undefined;
  }
  draws(): Draw[] {
    return (
      this.sql
        .prepare("SELECT payload FROM draws ORDER BY draw_no DESC")
        .all() as { payload: string }[]
    ).map((row) => JSON.parse(row.payload));
  }
  upsertDraw(draw: Draw): boolean {
    const old = this.draw(draw.drawNo);
    if (
      old?.status === "complete" &&
      (draw.status !== "complete" ||
        (old.source === "official" && draw.source === "github"))
    )
      return false;
    if (
      old &&
      JSON.stringify({ ...old, updatedAt: "" }) ===
        JSON.stringify({ ...draw, updatedAt: "" })
    )
      return false;
    this.sql
      .prepare(
        "INSERT INTO draws VALUES(?,?,?,?) ON CONFLICT(draw_no) DO UPDATE SET draw_date=excluded.draw_date,payload=excluded.payload,status=excluded.status",
      )
      .run(draw.drawNo, draw.drawDate, JSON.stringify(draw), draw.status);
    return true;
  }
  favorite(id: string, userId: string): Favorite | undefined {
    return this.favorites(userId).find((f) => f.id === id);
  }
  favorites(userId: string): Favorite[] {
    return (
      this.sql
        .prepare(
          "SELECT * FROM favorites WHERE user_id=? ORDER BY updated_at DESC",
        )
        .all(userId) as Record<string, unknown>[]
    ).map((row) => ({
      id: String(row.id),
      name: String(row.name),
      numbers: JSON.parse(String(row.numbers)),
      memo: String(row.memo),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    }));
  }
  saveFavorite(
    userId: string,
    input: Pick<Favorite, "name" | "numbers" | "memo">,
    id: string = randomUUID(),
    dates: { createdAt?: string; updatedAt?: string } = {},
  ): Favorite {
    const normalized = { ...input, numbers: validateNumbers(input.numbers) };
    return this.sql
      .transaction(() => {
        const old = this.favorite(id, userId);
        const key = numberCombinationKey(normalized.numbers);
        if (
          (!old || numberCombinationKey(old.numbers) !== key) &&
          this.favoriteByNumbers(userId, normalized.numbers, id)
        )
          throw new FavoriteDuplicateError();
        return this.writeFavorite(userId, normalized, id, dates);
      })
      .immediate();
  }
  favoriteByNumbers(userId: string, numbers: number[], excludeId?: string) {
    const key = numberCombinationKey(numbers);
    return this.favorites(userId).find(
      (favorite) =>
        favorite.id !== excludeId &&
        numberCombinationKey(favorite.numbers) === key,
    );
  }
  ensureFavorite(userId: string, numbers: number[]): EnsureFavoriteResponse {
    const normalized = validateNumbers(numbers);
    return this.sql
      .transaction(() => {
        const existing = this.favoriteByNumbers(userId, normalized);
        if (existing) return { favorite: existing, created: false };
        return {
          favorite: this.writeFavorite(
            userId,
            { numbers: normalized, name: "", memo: "" },
            randomUUID(),
          ),
          created: true,
        };
      })
      .immediate();
  }
  // Personal backup restore preserves legacy duplicate combinations.
  restoreFavorite(
    userId: string,
    input: Pick<Favorite, "name" | "numbers" | "memo">,
    id: string,
    dates: { createdAt?: string; updatedAt?: string } = {},
  ): Favorite {
    return this.writeFavorite(
      userId,
      { ...input, numbers: validateNumbers(input.numbers) },
      id,
      dates,
    );
  }
  private writeFavorite(
    userId: string,
    input: Pick<Favorite, "name" | "numbers" | "memo">,
    id: string,
    dates: { createdAt?: string; updatedAt?: string } = {},
  ): Favorite {
    const old = this.favorite(id, userId);
    const now = new Date().toISOString();
    this.sql
      .prepare(
        "INSERT INTO favorites VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,numbers=excluded.numbers,memo=excluded.memo,updated_at=excluded.updated_at WHERE favorites.user_id=excluded.user_id",
      )
      .run(
        id,
        userId,
        input.name,
        JSON.stringify(input.numbers),
        input.memo,
        dates.createdAt ?? old?.createdAt ?? now,
        dates.updatedAt ?? now,
      );
    const saved = this.favorite(id, userId);
    if (!saved) throw new Error("다른 계정의 번호 ID와 겹칩니다.");
    return saved;
  }
  deleteFavorite(id: string, userId: string) {
    return this.sql
      .prepare("DELETE FROM favorites WHERE id=? AND user_id=?")
      .run(id, userId).changes;
  }
  tickets(userId: string): PurchaseTicket[] {
    return (
      this.sql
        .prepare(
          "SELECT * FROM tickets WHERE user_id=? ORDER BY draw_no DESC,created_at DESC",
        )
        .all(userId) as Record<string, unknown>[]
    ).map((row) => ({
      id: String(row.id),
      drawNo: Number(row.draw_no),
      drawDate: String(row.draw_date),
      memo: String(row.memo),
      source: row.source as PurchaseTicket["source"],
      favoriteId: row.favorite_id as string | null,
      qrFingerprint: row.qr_fingerprint as string | null,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      games: (
        this.sql
          .prepare("SELECT * FROM games WHERE ticket_id=? ORDER BY position")
          .all(row.id) as Record<string, unknown>[]
      ).map((g) => ({
        id: String(g.id),
        numbers: JSON.parse(String(g.numbers)),
        quantity: Number(g.quantity),
      })),
    }));
  }
  saveTicket(
    userId: string,
    input: Omit<PurchaseTicket, "id" | "createdAt" | "updatedAt">,
    id: string = randomUUID(),
    dates: { createdAt?: string; updatedAt?: string } = {},
  ): PurchaseTicket {
    const old = this.tickets(userId).find((t) => t.id === id);
    const now = new Date().toISOString();
    this.sql.transaction(() => {
      this.sql
        .prepare(
          "INSERT INTO tickets(id,user_id,draw_no,draw_date,memo,source,favorite_id,qr_fingerprint,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET draw_no=excluded.draw_no,draw_date=excluded.draw_date,memo=excluded.memo,source=excluded.source,favorite_id=excluded.favorite_id,qr_fingerprint=excluded.qr_fingerprint,updated_at=excluded.updated_at",
        )
        .run(
          id,
          userId,
          input.drawNo,
          input.drawDate,
          input.memo,
          input.source,
          input.favoriteId,
          input.qrFingerprint,
          dates.createdAt ?? old?.createdAt ?? now,
          dates.updatedAt ?? now,
        );
      this.sql.prepare("DELETE FROM games WHERE ticket_id=?").run(id);
      const insert = this.sql.prepare("INSERT INTO games VALUES(?,?,?,?,?)");
      input.games.forEach((g, position) =>
        insert.run(
          g.id ?? randomUUID(),
          id,
          position,
          JSON.stringify(g.numbers),
          g.quantity,
        ),
      );
    })();
    return this.tickets(userId).find((t) => t.id === id)!;
  }
  deleteTicket(id: string, userId: string) {
    return this.sql
      .prepare("DELETE FROM tickets WHERE id=? AND user_id=?")
      .run(id, userId).changes;
  }
  job(id: string): SyncJob | undefined {
    const row = this.sql
      .prepare("SELECT * FROM sync_jobs WHERE id=?")
      .get(id) as Record<string, unknown> | undefined;
    return row ? this.toSyncJob(row) : undefined;
  }
  jobs(): SyncJob[] {
    return (
      this.sql
        .prepare(
          "SELECT * FROM sync_jobs ORDER BY created_at DESC, rowid DESC LIMIT 100",
        )
        .all() as Record<string, unknown>[]
    ).map((r) => this.toSyncJob(r));
  }
  latestJob(): SyncJob | null {
    const row = this.sql
      .prepare(
        "SELECT * FROM sync_jobs ORDER BY created_at DESC, rowid DESC LIMIT 1",
      )
      .get() as Record<string, unknown> | undefined;
    return row ? this.toSyncJob(row) : null;
  }
  activeJob(): SyncJob | undefined {
    const row = this.sql
      .prepare(
        "SELECT * FROM sync_jobs WHERE status IN ('queued','running') ORDER BY created_at DESC, rowid DESC LIMIT 1",
      )
      .get() as Record<string, unknown> | undefined;
    return row ? this.toSyncJob(row) : undefined;
  }
  private toSyncJob(r: Record<string, unknown>): SyncJob {
    return {
      id: String(r.id),
      mode: r.mode as SyncJob["mode"],
      status: r.status as SyncJob["status"],
      total: Number(r.total),
      processed: Number(r.processed),
      saved: Number(r.saved),
      fallbackCount: Number(r.fallback_count),
      errors: JSON.parse(String(r.errors)),
      createdAt: String(r.created_at),
      finishedAt: r.finished_at as string | null,
    };
  }
  createJob(
    mode: SyncJob["mode"],
    work: Record<string, unknown> = {},
  ): SyncJob {
    const active = this.activeJob();
    if (active) return active;
    const id = randomUUID();
    this.sql
      .prepare(
        "INSERT INTO sync_jobs(id,mode,status,work,created_at) VALUES(?,?,?,?,?)",
      )
      .run(id, mode, "queued", JSON.stringify(work), new Date().toISOString());
    return this.job(id)!;
  }
  work(id: string): Record<string, unknown> {
    return JSON.parse(
      (
        this.sql.prepare("SELECT work FROM sync_jobs WHERE id=?").get(id) as {
          work: string;
        }
      ).work,
    );
  }
  updateJob(job: SyncJob, work?: Record<string, unknown>) {
    this.sql
      .prepare(
        "UPDATE sync_jobs SET status=?,total=?,processed=?,saved=?,fallback_count=?,errors=?,finished_at=? WHERE id=?",
      )
      .run(
        job.status,
        job.total,
        job.processed,
        job.saved,
        job.fallbackCount,
        JSON.stringify(job.errors.slice(-100)),
        job.finishedAt,
        job.id,
      );
    if (work)
      this.sql
        .prepare("UPDATE sync_jobs SET work=? WHERE id=?")
        .run(JSON.stringify(work), job.id);
  }
  async snapshot(backupDirectory: string) {
    mkdirSync(backupDirectory, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const filename = resolve(backupDirectory, `lotto-${stamp}.sqlite`);
    await this.sql.backup(filename);
    return filename;
  }
}

export function databasePath(dataDirectory: string): string {
  return resolve(dataDirectory, "lotto.sqlite");
}
