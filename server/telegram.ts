import { setTimeout as delay } from "node:timers/promises";
import { Store } from "./db.js";
import { SyncEngine } from "./sync.js";
import { purchaseInput, qrPurchaseInput } from "./records.js";
import {
  TelegramApi,
  TelegramError,
  MAX_IMAGE_BYTES,
  type TelegramTransport,
} from "./telegram-api.js";
import { QrDecoder } from "./telegram-qr.js";
import {
  HELP,
  historyMessage,
  roundReport,
  splitMessage,
  latestDueDraw,
  nextRefresh,
} from "./telegram-messages.js";

export interface TelegramConfig {
  token: string;
  allowedUserId: string;
  siteUsername: string;
  origin: string;
}
interface Photo {
  file_id: string;
  width: number;
  height: number;
  file_size?: number;
}
export interface TelegramUpdate {
  update_id: number;
  message?: {
    from?: { id: number; is_bot?: boolean };
    chat: { id: number; type: string };
    text?: string;
    photo?: Photo[];
    document?: { file_id: string; mime_type?: string; file_size?: number };
  };
}
interface OutboxRow {
  id: number;
  text: string;
  attempts: number;
  next_attempt_at: number;
}
interface ReportRow {
  draw_no: number;
  final_queued: number;
  next_refresh_at: number;
}

export function telegramConfig(
  env: NodeJS.ProcessEnv,
  origin: string,
): TelegramConfig | null {
  if (env.TELEGRAM_ENABLED !== "true") return null;
  const token = env.TELEGRAM_BOT_TOKEN ?? "";
  const allowedUserId = env.TELEGRAM_ALLOWED_USER_ID ?? "";
  if (
    !/^\d+:[\w-]{20,}$/.test(token) ||
    !/^[1-9]\d*$/.test(allowedUserId) ||
    !Number.isSafeInteger(Number(allowedUserId))
  )
    throw new Error("텔레그램 환경변수 설정을 확인해 주세요.");
  return {
    token,
    allowedUserId,
    siteUsername:
      env.TELEGRAM_SITE_USERNAME || env.BOOTSTRAP_USERNAME || "textimage",
    origin: origin.replace(/\/$/, ""),
  };
}

export class TelegramBot {
  private botId = "";
  private userId = "";
  private scope = "";
  private readonly abort = new AbortController();
  private polling: Promise<void> | null = null;
  private flushing: Promise<void> | null = null;
  private ticking: Promise<void> | null = null;
  private syncing: Promise<void> | null = null;
  private timer?: ReturnType<typeof setInterval>;
  private stopped = false;
  private lastSentAt = 0;
  private readonly decode: (bytes: Buffer) => Promise<string>;
  constructor(
    readonly store: Store,
    private readonly engine: Pick<SyncEngine, "idle" | "start">,
    readonly config: TelegramConfig,
    private readonly api: TelegramTransport = new TelegramApi(config.token),
    private readonly decoder = new QrDecoder(),
    private readonly now: () => Date = () => new Date(),
    decode?: (bytes: Buffer) => Promise<string>,
  ) {
    this.decode = decode ?? ((bytes) => decoder.decode(bytes));
  }

  private log(event: string, error?: unknown) {
    console.error(
      JSON.stringify({
        event,
        ...(error instanceof TelegramError ? { code: error.code } : {}),
      }),
    );
  }
  async initialize() {
    const user = this.store.sql
      .prepare("SELECT id FROM users WHERE username=?")
      .get(this.config.siteUsername) as { id: string } | undefined;
    if (!user)
      throw new Error("텔레그램에 지정한 사이트 계정을 찾지 못했습니다.");
    const me = await this.api.call<{ id: number; is_bot: boolean }>(
      "getMe",
      {},
      this.abort.signal,
    );
    if (!me.is_bot || !Number.isSafeInteger(me.id)) throw new TelegramError(0);
    const webhook = await this.api.call<{ url: string }>(
      "getWebhookInfo",
      {},
      this.abort.signal,
    );
    if (webhook.url)
      throw new Error("기존 webhook을 해제한 뒤 텔레그램 봇을 시작해 주세요.");
    if (this.stopped) return;
    this.botId = String(me.id);
    this.userId = user.id;
    this.scope = `${this.botId}:${this.userId}:${this.config.allowedUserId}`;
    this.store.sql.transaction(() => {
      this.store.sql
        .prepare("INSERT OR IGNORE INTO telegram_state(bot_id) VALUES(?)")
        .run(this.botId);
      this.store.sql
        .prepare(
          "INSERT OR IGNORE INTO telegram_accounts(scope,activated_at) VALUES(?,?)",
        )
        .run(this.scope, this.now().getTime());
    })();
  }
  async start() {
    let failures = 0;
    while (!this.stopped) {
      try {
        await this.initialize();
        break;
      } catch (error) {
        if (this.stopped) return;
        if (
          !(error instanceof TelegramError) ||
          (error.code !== 0 && error.code !== 429 && error.code < 500)
        )
          throw error;
        this.log("telegram_connect_failed", error);
        await this.pause(
          Math.max(
            error.retryAfter * 1000,
            Math.min(300000, 1000 * 2 ** Math.min(++failures, 9)),
          ),
        );
      }
    }
    if (this.stopped) return;
    // Intake and QR workers do not block scheduled reports or the HTTP server.
    this.polling = this.poll();
    this.timer = setInterval(() => {
      void this.tick().catch((e) => this.log("telegram_tick_failed", e));
    }, 1000);
    void this.tick().catch((e) => this.log("telegram_tick_failed", e));
    console.log(JSON.stringify({ event: "telegram_started" }));
  }
  private account() {
    return this.store.sql
      .prepare(
        "SELECT activated_at,blocked FROM telegram_accounts WHERE scope=?",
      )
      .get(this.scope) as { activated_at: number; blocked: number };
  }
  private offset(): number {
    return (
      this.store.sql
        .prepare("SELECT next_update_id FROM telegram_state WHERE bot_id=?")
        .get(this.botId) as { next_update_id: number }
    ).next_update_id;
  }
  private queue(key: string, text: string) {
    splitMessage(text).forEach((part, i) =>
      this.store.sql
        .prepare(
          "INSERT OR IGNORE INTO telegram_outbox(scope,delivery_key,part,text) VALUES(?,?,?,?)",
        )
        .run(this.scope, key, i, part),
    );
  }
  private processed(update: TelegramUpdate, respond?: () => string) {
    this.store.sql.transaction(() => {
      if (update.update_id < this.offset()) return;
      if (respond) this.queue(`update:${update.update_id}`, respond());
      this.store.sql
        .prepare("INSERT OR IGNORE INTO telegram_updates VALUES(?,?,?)")
        .run(this.botId, update.update_id, this.now().getTime());
      this.store.sql
        .prepare("UPDATE telegram_state SET next_update_id=? WHERE bot_id=?")
        .run(update.update_id + 1, this.botId);
    })();
  }
  async handleUpdate(update: TelegramUpdate) {
    if (!Number.isSafeInteger(update.update_id) || update.update_id < 0)
      throw new TelegramError(0);
    if (update.update_id < this.offset()) return;
    const m = update.message;
    if (
      !m ||
      m.chat.type !== "private" ||
      m.from?.is_bot ||
      String(m.from?.id) !== this.config.allowedUserId ||
      String(m.chat.id) !== this.config.allowedUserId
    ) {
      this.processed(update);
      return;
    }
    if (/^\/(start|help)(?:@\w+)?(?:\s|$)/.test(m.text ?? "")) {
      this.processed(update, () => {
        this.store.sql
          .prepare("UPDATE telegram_accounts SET blocked=0 WHERE scope=?")
          .run(this.scope);
        this.store.sql
          .prepare(
            "UPDATE telegram_outbox SET next_attempt_at=0 WHERE scope=? AND sent_at IS NULL",
          )
          .run(this.scope);
        return HELP;
      });
    } else if (m.photo?.length || m.document) {
      const file = m.photo?.length
        ? [...m.photo].sort(
            (a, b) => b.width * b.height - a.width * a.height,
          )[0]
        : m.document!;
      if ((file.file_size ?? 0) > MAX_IMAGE_BYTES) {
        this.processed(update, () => "사진은 20MB 이하로 보내 주세요.");
      } else if (
        !m.photo?.length &&
        !["image/jpeg", "image/png"].includes(m.document?.mime_type ?? "")
      ) {
        this.processed(update, () => "JPEG 또는 PNG 사진 파일을 보내 주세요.");
      } else {
        let raw: string;
        try {
          raw = await this.decode(
            await this.api.download(file.file_id, this.abort.signal),
          );
        } catch (error) {
          if (error instanceof TelegramError && error.code !== 400) throw error;
          if (this.stopped) return;
          if (error instanceof TelegramError) {
            this.processed(
              update,
              () => "사진 파일을 내려받지 못했습니다. 사진을 다시 보내 주세요.",
            );
            return;
          }
          this.processed(update, () =>
            error instanceof Error
              ? error.message
              : "사진을 읽지 못했습니다. QR 부분을 확대해서 다시 보내 주세요.",
          );
          return;
        }
        let input: ReturnType<typeof purchaseInput>;
        try {
          const qr = qrPurchaseInput(this.store, raw);
          input = purchaseInput(
            this.store,
            { ...qr, source: "qr", qrRaw: raw },
            this.userId,
          );
        } catch {
          this.processed(
            update,
            () =>
              "올바른 로또 6/45 QR을 찾지 못했습니다. QR 부분을 확대해서 다시 보내 주세요.",
          );
          return;
        }
        this.processed(update, () => {
          const duplicate = this.store.sql
            .prepare(
              "SELECT id FROM tickets WHERE user_id=? AND qr_fingerprint=?",
            )
            .get(this.userId, input.qrFingerprint);
          if (duplicate) return "이미 등록한 복권 QR입니다.";
          const ticket = this.store.saveTicket(this.userId, input);
          return [
            `QR 구매 등록 완료 · 제${ticket.drawNo}회 (${ticket.drawDate})`,
            ...ticket.games.map(
              (g, i) => `게임 ${i + 1}: ${g.numbers.join(" ")} ×${g.quantity}`,
            ),
            `${this.config.origin}/purchases?drawNo=${ticket.drawNo}`,
          ].join("\n");
        });
      }
    } else if (m.text) {
      let reply: string;
      try {
        reply = historyMessage(this.store, m.text);
      } catch {
        reply =
          "1~45의 서로 다른 번호 6개를 공백 또는 쉼표로 보내 주세요.\n예: 1 7 13 22 35 44\n/help — 사용법";
      }
      this.processed(update, () => reply);
    } else
      this.processed(
        update,
        () => "번호 6개 또는 로또 용지의 JPEG·PNG 사진을 보내 주세요. /help",
      );
  }
  private async poll() {
    let failures = 0;
    while (!this.stopped) {
      try {
        const updates = await this.api.call<TelegramUpdate[]>(
          "getUpdates",
          {
            offset: this.offset(),
            timeout: 30,
            allowed_updates: ["message"],
          },
          this.abort.signal,
        );
        if (!Array.isArray(updates)) throw new TelegramError(0);
        for (const update of updates) {
          if (this.stopped) break;
          await this.handleUpdate(update);
        }
        failures = 0;
        void this.flush().catch((e) => this.log("telegram_send_failed", e));
      } catch (error) {
        if (this.stopped) break;
        this.log("telegram_poll_failed", error);
        if (error instanceof TelegramError && [401, 409].includes(error.code)) {
          // An invalid token / competing receiver requires configuration changes.
          if (this.timer) clearInterval(this.timer);
          this.stopped = true;
          this.abort.abort();
          await this.decoder.stop();
          break;
        }
        await this.pause(
          Math.max(
            error instanceof TelegramError ? error.retryAfter * 1000 : 0,
            Math.min(300000, 1000 * 2 ** Math.min(++failures, 9)),
          ),
        );
      }
    }
  }
  private async pause(ms: number) {
    try {
      await delay(ms, undefined, { signal: this.abort.signal });
    } catch {
      /* shutdown */
    }
  }
  tick(): Promise<void> {
    if (!this.scope || this.stopped) return Promise.resolve();
    if (this.ticking) return this.ticking;
    this.ticking = this.runTick().finally(() => {
      this.ticking = null;
    });
    return this.ticking;
  }
  private async runTick() {
    if (this.account().blocked) return;
    const now = this.now();
    const due = latestDueDraw(now);
    let refresh = false;
    this.store.sql.transaction(() => {
      if (
        due.dueAt >= this.account().activated_at &&
        due.dueAt <= now.getTime()
      ) {
        const exists = this.store.sql
          .prepare("SELECT 1 FROM telegram_reports WHERE scope=? AND draw_no=?")
          .get(this.scope, due.drawNo);
        if (!exists) {
          const complete = this.store.draw(due.drawNo)?.status === "complete";
          this.queue(
            `draw:${due.drawNo}:initial`,
            roundReport(
              this.store,
              this.userId,
              due.drawNo,
              this.config.origin,
              now,
            ),
          );
          this.store.sql
            .prepare("INSERT INTO telegram_reports VALUES(?,?,?,?,?)")
            .run(
              this.scope,
              due.drawNo,
              now.getTime(),
              Number(complete),
              nextRefresh(due.drawNo, now),
            );
          refresh = true;
        }
      }
      const pending = this.store.sql
        .prepare(
          "SELECT * FROM telegram_reports WHERE scope=? AND final_queued=0 ORDER BY draw_no",
        )
        .all(this.scope) as ReportRow[];
      for (const report of pending) {
        if (this.store.draw(report.draw_no)?.status === "complete") {
          this.queue(
            `draw:${report.draw_no}:final`,
            roundReport(
              this.store,
              this.userId,
              report.draw_no,
              this.config.origin,
              now,
              true,
            ),
          );
          this.store.sql
            .prepare(
              "UPDATE telegram_reports SET final_queued=1 WHERE scope=? AND draw_no=?",
            )
            .run(this.scope, report.draw_no);
        } else if (report.next_refresh_at <= now.getTime()) {
          this.store.sql
            .prepare(
              "UPDATE telegram_reports SET next_refresh_at=? WHERE scope=? AND draw_no=?",
            )
            .run(nextRefresh(report.draw_no, now), this.scope, report.draw_no);
          refresh = true;
        }
      }
    })();
    if (refresh) this.refresh();
    await this.flush();
  }
  private refresh() {
    if (this.syncing || this.stopped) return;
    this.syncing = (async () => {
      // start() reuses an existing job, so wait before requesting our latest refresh.
      await this.engine.idle();
      if (this.stopped) return;
      this.engine.start("latest");
      await this.engine.idle();
    })()
      .catch((e) => this.log("telegram_refresh_failed", e))
      .finally(() => {
        this.syncing = null;
        if (!this.stopped)
          void this.tick().catch((e) => this.log("telegram_tick_failed", e));
      });
  }
  flush(): Promise<void> {
    if (!this.scope || this.stopped) return Promise.resolve();
    if (this.flushing) return this.flushing;
    this.flushing = this.sendPending().finally(() => {
      this.flushing = null;
    });
    return this.flushing;
  }
  private async sendPending() {
    if (this.account().blocked) return;
    while (!this.stopped) {
      const row = this.store.sql
        .prepare(
          "SELECT * FROM telegram_outbox WHERE scope=? AND sent_at IS NULL ORDER BY id LIMIT 1",
        )
        .get(this.scope) as OutboxRow | undefined;
      if (!row || row.next_attempt_at > this.now().getTime()) return;
      const wait = this.lastSentAt + 1000 - Date.now();
      if (wait > 0) await this.pause(wait);
      if (this.stopped) return;
      try {
        const message = await this.api.call<{ message_id: number }>(
          "sendMessage",
          {
            chat_id: this.config.allowedUserId,
            text: row.text,
            link_preview_options: { is_disabled: true },
          },
          this.abort.signal,
        );
        if (!Number.isSafeInteger(message.message_id))
          throw new TelegramError(0);
        this.lastSentAt = Date.now();
        this.store.sql
          .prepare(
            "UPDATE telegram_outbox SET sent_at=?,message_id=? WHERE id=?",
          )
          .run(this.now().getTime(), message.message_id, row.id);
      } catch (error) {
        if (this.stopped) return;
        this.log("telegram_send_failed", error);
        if (error instanceof TelegramError && error.code === 403)
          this.store.sql
            .prepare("UPDATE telegram_accounts SET blocked=1 WHERE scope=?")
            .run(this.scope);
        const seconds = Math.max(
          error instanceof TelegramError ? error.retryAfter : 0,
          Math.min(300, 2 ** Math.min(row.attempts + 1, 9)),
        );
        this.store.sql
          .prepare(
            "UPDATE telegram_outbox SET attempts=attempts+1,next_attempt_at=? WHERE id=?",
          )
          .run(this.now().getTime() + seconds * 1000, row.id);
        return;
      }
    }
  }
  async stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.abort.abort();
    await this.decoder.stop();
    await Promise.allSettled([
      this.polling,
      this.ticking,
      this.flushing,
      this.syncing,
    ]);
  }
}

export function configuredTelegramBot(
  store: Store,
  engine: SyncEngine,
  origin: string,
): TelegramBot | null {
  try {
    const config = telegramConfig(process.env, origin);
    return config ? new TelegramBot(store, engine, config) : null;
  } catch {
    console.error(JSON.stringify({ event: "telegram_configuration_invalid" }));
    return null;
  }
}
