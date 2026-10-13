import { Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { bodyLimit } from "hono/body-limit";
import { secureHeaders } from "hono/secure-headers";
import { z, ZodError } from "zod";
import { randomInt } from "node:crypto";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { IncomingMessage } from "node:http";
import { Store, FavoriteDuplicateError } from "./db.js";
import { SyncEngine, createBackup } from "./sync.js";
import {
  GENERATION_ALGORITHM_IDS,
  GENERATION_SPANS,
  generateCombinations,
  generationAlgorithm,
} from "../shared/generator.js";
import {
  numbersSchema,
  gameSchema,
  purchaseInput as recordsPurchaseInput,
  ticketView as recordsTicketView,
  history,
} from "./records.js";
import {
  hashPassword,
  issueSession,
  loginLocked,
  recordFailure,
  sessionUser,
  tokenHash,
  verifyPassword,
} from "./auth.js";
import {
  drawDateFor,
  roundForDate,
  koreanDate,
  nextPurchaseRound,
  parseLottoQr,
  type Favorite,
  type PurchaseTicket,
  type PurchaseRoundGroup,
  type SyncJob,
} from "../shared/domain.js";

const favoriteSchema = z.object({
  name: z.string().trim().max(80).default(""),
  numbers: numbersSchema,
  memo: z.string().max(2000).default(""),
});
const settingsSchema = z.object({ autoSync: z.boolean() });
const cookieName = "lotto_session";

export interface AppOptions {
  production?: boolean;
  origin?: string;
  trustProxy?: boolean;
  backupDirectory?: string;
}
export function createApp(
  store: Store,
  engine: SyncEngine,
  options: AppOptions = {},
) {
  const ticketView = (ticket: PurchaseTicket) =>
    recordsTicketView(store, ticket);
  const purchaseInput = (
    raw: unknown,
    userId: string,
    originalFavoriteId?: string | null,
  ) => recordsPurchaseInput(store, raw, userId, originalFavoriteId);
  const app = new Hono<{
    Variables: { user: { id: string; username: string } };
    Bindings: { incoming?: IncomingMessage };
  }>();
  const origin = options.origin ?? "https://lotto.mintwool.com";
  const allowed = new Set([
    origin,
    ...(!options.production
      ? [
          "http://127.0.0.1:5173",
          "http://localhost:5173",
          "http://127.0.0.1:3000",
          "http://localhost:3000",
        ]
      : []),
  ]);
  app.use(
    "*",
    secureHeaders(
      options.production
        ? {
            contentSecurityPolicy: {
              defaultSrc: ["'self'"],
              scriptSrc: ["'self'"],
              styleSrc: ["'self'", "'unsafe-inline'"],
              imgSrc: ["'self'", "data:", "blob:"],
              mediaSrc: ["'self'", "blob:"],
              connectSrc: ["'self'"],
              frameAncestors: ["'none'"],
            },
            permissionsPolicy: {
              camera: ["self"],
              microphone: [],
              geolocation: [],
            },
          }
        : {},
    ),
  );
  app.use("/api/*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    if (
      !["GET", "HEAD", "OPTIONS"].includes(c.req.method) &&
      !allowed.has(c.req.header("Origin") ?? "")
    )
      return c.json(
        {
          error:
            "요청 출처를 확인할 수 없습니다. 사이트에서 다시 시도해 주세요.",
        },
        403,
      );
    const user = sessionUser(store, getCookie(c, cookieName));
    if (user) c.set("user", user);
    const publicPaths = ["/api/auth/login", "/api/auth/session"];
    if (!publicPaths.includes(c.req.path) && !user)
      return c.json({ error: "로그인이 필요합니다." }, 401);
    await next();
  });
  app.use("/api/*", (c, next) =>
    bodyLimit({
      maxSize: c.req.path === "/api/backup/restore" ? 10 * 1024 * 1024 : 65536,
      onError: (c) => c.json({ error: "입력 데이터가 너무 큽니다." }, 413),
    })(c, next),
  );
  app.onError((error, c) => {
    if (error instanceof FavoriteDuplicateError)
      return c.json({ error: error.message }, 409);
    if (error instanceof ZodError)
      return c.json(
        {
          error: "입력값을 확인해 주세요.",
          details: error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
        },
        400,
      );
    const message = error.message;
    if (
      message.includes(
        "UNIQUE constraint failed: tickets.user_id, tickets.qr_fingerprint",
      )
    )
      return c.json({ error: "이미 등록한 복권 QR입니다." }, 409);
    if (
      message.includes("constraint failed") ||
      message.includes("SQLITE") ||
      ("code" in error && String(error.code).startsWith("SQLITE"))
    ) {
      console.error(
        JSON.stringify({ event: "database_error", path: c.req.path, message }),
      );
      return c.json(
        { error: "저장 중 오류가 발생했습니다. 다시 시도해 주세요." },
        500,
      );
    }
    return c.json({ error: message || "요청을 처리하지 못했습니다." }, 400);
  });
  app.get("/healthz", (c) => c.json({ ok: true }));
  app.get("/api/auth/session", (c) =>
    c.json({
      user: c.get("user") ? { username: c.get("user").username } : null,
    }),
  );
  app.post("/api/auth/login", async (c) => {
    const input = z
      .object({
        username: z.string().trim().min(1).max(80),
        password: z.string().min(1).max(256),
      })
      .parse(await c.req.json());
    const ip = options.trustProxy
      ? (c.req.header("x-real-ip") ?? "unknown")
      : (c.env?.incoming?.socket.remoteAddress ?? "local");
    const keys = ["ip:" + ip, "user:" + input.username];
    if (loginLocked(store, keys))
      return c.json(
        { error: "로그인 시도가 많습니다. 15분 후 다시 시도해 주세요." },
        429,
      );
    const user = store.sql
      .prepare("SELECT * FROM users WHERE username=?")
      .get(input.username) as
      { id: string; username: string; password_hash: string } | undefined;
    const fallback = store.sql
      .prepare("SELECT password_hash FROM users LIMIT 1")
      .get() as { password_hash: string } | undefined;
    const valid = await verifyPassword(
      input.password,
      user?.password_hash ?? fallback?.password_hash ?? "",
    );
    if (!user || !valid) {
      recordFailure(store, keys);
      return c.json({ error: "아이디 또는 비밀번호를 확인해 주세요." }, 401);
    }
    for (const key of keys)
      store.sql.prepare("DELETE FROM auth_throttles WHERE key=?").run(key);
    const token = issueSession(store, user.id);
    setCookie(c, cookieName, token, {
      httpOnly: true,
      secure: !!options.production,
      sameSite: "Lax",
      path: "/",
      maxAge: 7 * 86400,
    });
    return c.json({ user: { username: user.username } });
  });
  app.post("/api/auth/logout", (c) => {
    const token = getCookie(c, cookieName);
    if (token)
      store.sql
        .prepare("DELETE FROM sessions WHERE token_hash=?")
        .run(tokenHash(token));
    deleteCookie(c, cookieName, { path: "/", secure: !!options.production });
    return c.json({ ok: true });
  });
  app.post("/api/auth/password", async (c) => {
    const input = z
      .object({
        currentPassword: z.string().min(1).max(256),
        newPassword: z
          .string()
          .min(8, "새 비밀번호는 8자 이상이어야 합니다.")
          .max(256),
      })
      .parse(await c.req.json());
    const user = c.get("user");
    const throttleKey = "password:" + user.id;
    if (loginLocked(store, [throttleKey]))
      return c.json(
        { error: "시도가 많습니다. 15분 후 다시 시도해 주세요." },
        429,
      );
    const row = store.sql
      .prepare("SELECT password_hash FROM users WHERE id=?")
      .get(user.id) as { password_hash: string };
    if (!(await verifyPassword(input.currentPassword, row.password_hash))) {
      recordFailure(store, [throttleKey]);
      return c.json({ error: "현재 비밀번호를 확인해 주세요." }, 400);
    }
    const hash = await hashPassword(input.newPassword);
    store.sql.transaction(() => {
      store.sql
        .prepare("UPDATE users SET password_hash=? WHERE id=?")
        .run(hash, user.id);
      store.sql.prepare("DELETE FROM sessions WHERE user_id=?").run(user.id);
      store.sql
        .prepare("DELETE FROM auth_throttles WHERE key=?")
        .run(throttleKey);
    })();
    deleteCookie(c, cookieName, { path: "/", secure: !!options.production });
    return c.json({ ok: true });
  });
  const coverage = () => {
    const draws = store.draws();
    const latest = draws[0]?.drawNo ?? 0;
    const present = new Set(draws.map((d) => d.drawNo));
    return {
      total: draws.length,
      complete: draws.filter((d) => d.status === "complete").length,
      latest,
      missing: Array.from({ length: latest }, (_, i) => i + 1).filter(
        (n) => !present.has(n),
      ),
    };
  };
  app.get("/api/meta", (c) =>
    c.json({
      nextRound: nextPurchaseRound(),
      nextDate: drawDateFor(nextPurchaseRound()),
      today: koreanDate(),
      coverage: coverage(),
      latestJob: store.latestJob(),
    }),
  );
  app.get("/api/dashboard", (c) => {
    const month = z
      .string()
      .regex(/^\d{4}-\d{2}$/)
      .parse(c.req.query("month") ?? koreanDate().slice(0, 7));
    const all = store.tickets(c.get("user").id).map(ticketView);
    const selected = all.filter((t) => t.drawDate.startsWith(month));
    const confirmedPrize = selected.reduce(
      (sum, t) => sum + t.confirmedPrize,
      0,
    );
    const totalGames = selected.reduce(
      (sum, t) => sum + t.games.reduce((n, g) => n + g.quantity, 0),
      0,
    );
    const unsettledGames = selected.reduce(
      (sum, t) => sum + t.unsettledGames,
      0,
    );
    const wonGames = selected.reduce(
      (sum, t) =>
        sum +
        t.results.reduce(
          (n, r, i) => n + (r.status === "won" ? t.games[i].quantity : 0),
          0,
        ),
      0,
    );
    return c.json({
      month,
      latest: store.draws()[0] ?? null,
      nextRound: nextPurchaseRound(),
      nextDate: drawDateFor(nextPurchaseRound()),
      confirmedPrize,
      totalGames,
      unsettledGames,
      wonGames,
      settledGames: totalGames - unsettledGames,
      recent: all.slice(0, 5),
      favoriteCount: store.favorites(c.get("user").id).length,
      coverage: coverage(),
      latestJob: store.latestJob(),
    });
  });
  app.get("/api/favorites", (c) =>
    c.json({ favorites: store.favorites(c.get("user").id) }),
  );
  app.post("/api/favorites", async (c) =>
    c.json(
      store.saveFavorite(
        c.get("user").id,
        favoriteSchema.parse(await c.req.json()),
      ),
      201,
    ),
  );
  app.post("/api/favorites/ensure", async (c) => {
    const { numbers } = z
      .object({ numbers: numbersSchema })
      .parse(await c.req.json());
    const result = store.ensureFavorite(c.get("user").id, numbers);
    return c.json(result, result.created ? 201 : 200);
  });
  app.put("/api/favorites/:id", async (c) => {
    if (!store.favorite(c.req.param("id"), c.get("user").id))
      return c.json({ error: "조합을 찾지 못했습니다." }, 404);
    return c.json(
      store.saveFavorite(
        c.get("user").id,
        favoriteSchema.parse(await c.req.json()),
        c.req.param("id"),
      ),
    );
  });
  app.delete("/api/favorites/:id", (c) => {
    if (!store.deleteFavorite(c.req.param("id"), c.get("user").id))
      return c.json({ error: "조합을 찾지 못했습니다." }, 404);
    return c.json({ ok: true });
  });
  app.post("/api/favorites/:id/purchase", (c) => {
    const favorite = store.favorite(c.req.param("id"), c.get("user").id);
    if (!favorite) return c.json({ error: "조합을 찾지 못했습니다." }, 404);
    const drawNo = nextPurchaseRound();
    return c.json(
      ticketView(
        store.saveTicket(c.get("user").id, {
          drawNo,
          drawDate: drawDateFor(drawNo),
          memo: favorite.memo || favorite.name,
          games: [{ numbers: [...favorite.numbers], quantity: 1 }],
          source: "favorite",
          favoriteId: favorite.id,
          qrFingerprint: null,
        }),
      ),
      201,
    );
  });
  app.get("/api/round", (c) => {
    const no = c.req.query("date")
      ? roundForDate(c.req.query("date")!)
      : Number(c.req.query("drawNo"));
    const date = store.draw(no)?.drawDate ?? drawDateFor(no);
    return c.json({ drawNo: no, drawDate: date });
  });
  app.get("/api/purchases", (c) => {
    let tickets = store.tickets(c.get("user").id).map(ticketView);
    if (c.req.query("month"))
      tickets = tickets.filter((t) =>
        t.drawDate.startsWith(c.req.query("month")!),
      );
    if (c.req.query("drawNo"))
      tickets = tickets.filter(
        (t) => t.drawNo === Number(c.req.query("drawNo")),
      );
    const status = c.req.query("status");
    if (status)
      tickets = tickets.filter((t) =>
        t.results.some((r) => r.status === status),
      );
    const page = Math.max(1, Number(c.req.query("page")) || 1);
    const size = 12;
    if (c.req.query("groupBy") === "draw") {
      const byRound = new Map<number, PurchaseRoundGroup>();
      for (const ticket of tickets) {
        let group = byRound.get(ticket.drawNo);
        if (!group) {
          group = {
            drawNo: ticket.drawNo,
            drawDate: ticket.drawDate,
            totalGames: 0,
            tickets: [],
          };
          byRound.set(ticket.drawNo, group);
        }
        group.tickets.push(ticket);
        group.totalGames += ticket.games.reduce(
          (sum, game) => sum + game.quantity,
          0,
        );
      }
      const groups = [...byRound.values()].sort((a, b) => b.drawNo - a.drawNo);
      return c.json({
        groups: groups.slice((page - 1) * size, page * size),
        total: groups.length,
        totalGames: groups.reduce((sum, group) => sum + group.totalGames, 0),
        latestRounds: groups.slice(0, 2).map((group) => group.drawNo),
        page,
        pageSize: size,
      });
    }
    return c.json({
      tickets: tickets.slice((page - 1) * size, page * size),
      total: tickets.length,
      page,
      pageSize: size,
    });
  });
  app.post("/api/purchases", async (c) =>
    c.json(
      ticketView(
        store.saveTicket(
          c.get("user").id,
          purchaseInput(await c.req.json(), c.get("user").id),
        ),
      ),
      201,
    ),
  );
  app.put("/api/purchases/:id", async (c) => {
    const ticket = store
      .tickets(c.get("user").id)
      .find((t) => t.id === c.req.param("id"));
    if (!ticket) return c.json({ error: "구매 기록을 찾지 못했습니다." }, 404);
    if (ticket.source === "qr") {
      const raw = z
        .object({
          memo: z.string().max(2000),
        })
        .parse(await c.req.json());
      return c.json(
        ticketView(
          store.saveTicket(c.get("user").id, { ...ticket, ...raw }, ticket.id),
        ),
      );
    }
    return c.json(
      ticketView(
        store.saveTicket(
          c.get("user").id,
          purchaseInput(
            await c.req.json(),
            c.get("user").id,
            ticket.favoriteId,
          ),
          ticket.id,
        ),
      ),
    );
  });
  app.delete("/api/purchases/:id", (c) => {
    if (!store.deleteTicket(c.req.param("id"), c.get("user").id))
      return c.json({ error: "구매 기록을 찾지 못했습니다." }, 404);
    return c.json({ ok: true });
  });
  app.post("/api/qr/parse", async (c) => {
    const { raw } = z
      .object({ raw: z.string().max(2048) })
      .parse(await c.req.json());
    const qr = parseLottoQr(raw);
    return c.json({
      ...qr,
      drawDate: store.draw(qr.drawNo)?.drawDate ?? drawDateFor(qr.drawNo),
    });
  });
  app.post("/api/history", async (c) => {
    const input = z
      .object({
        numbers: numbersSchema,
        from: z.number().int().min(1).optional(),
        to: z.number().int().min(1).optional(),
        dateFrom: z.string().optional(),
        dateTo: z.string().optional(),
        rank: z.number().int().min(1).max(5).optional(),
        page: z.number().int().min(1).default(1),
      })
      .parse(await c.req.json());
    return c.json(history(store, input));
  });
  app.get("/api/draws", (c) => {
    const query = (c.req.query("q") ?? "").trim();
    const draws = store
      .draws()
      .filter(
        (d) =>
          !query ||
          (/^\d+$/.test(query)
            ? d.drawNo === Number(query)
            : d.drawDate.includes(query.replaceAll(".", "-"))),
      );
    const page = Math.max(1, Number(c.req.query("page")) || 1);
    return c.json({
      draws: draws.slice((page - 1) * 15, page * 15),
      total: draws.length,
      page,
      pageSize: 15,
    });
  });
  app.get("/api/draws/:no", (c) => {
    const draw = store.draw(Number(c.req.param("no")));
    return draw
      ? c.json(draw)
      : c.json({ error: "아직 수집되지 않은 회차입니다." }, 404);
  });
  app.get("/api/stats", (c) => {
    const span = z
      .enum(["10", "50", "100", "all"])
      .parse(c.req.query("span") ?? "100");
    const all = store.draws();
    const draws = span === "all" ? all : all.slice(0, Number(span));
    const frequencies = Array.from({ length: 45 }, (_, i) => ({
      number: i + 1,
      count: 0,
      lastSeen: null as number | null,
      gap: null as number | null,
    }));
    let odd = 0;
    const ranges = [0, 0, 0, 0, 0];
    for (const draw of draws)
      for (const number of draw.numbers) {
        const f = frequencies[number - 1];
        f.count++;
        if (f.lastSeen === null) f.lastSeen = draw.drawNo;
        if (number % 2) odd++;
        ranges[Math.floor((number - 1) / 10)]++;
      }
    for (const f of frequencies) {
      const last = all.find((d) => d.numbers.includes(f.number));
      f.gap = last ? all[0].drawNo - last.drawNo : null;
    }
    return c.json({
      span,
      count: draws.length,
      frequencies,
      odd,
      even: draws.length * 6 - odd,
      ranges,
      latest: all[0]?.drawNo ?? null,
    });
  });
  app.post("/api/generate", async (c) => {
    const input = z
      .object({
        count: z.number().int().min(1).max(20).default(5),
        included: z.array(z.number().int()).default([]),
        excluded: z.array(z.number().int()).default([]),
        algorithm: z.enum(GENERATION_ALGORITHM_IDS).default("random"),
        span: z.enum(GENERATION_SPANS).default("100"),
        balance: z
          .object({
            oddCount: z.number().int().min(0).max(6).nullable(),
            ranges: z
              .array(
                z.object({
                  min: z.number().int().min(0).max(6),
                  max: z.number().int().min(0).max(6),
                }),
              )
              .length(5),
          })
          .optional(),
        scoreWeights: z
          .object({
            frequency: z.number().int().min(0).max(100),
            recent: z.number().int().min(0).max(100),
            overdue: z.number().int().min(0).max(100),
          })
          .optional(),
      })
      .parse(await c.req.json());
    return c.json(
      generateCombinations(
        input,
        generationAlgorithm(input.algorithm).requiresHistory
          ? store.draws()
          : [],
        () => randomInt(0, 0x100000000) / 0x100000000,
      ),
    );
  });
  app.get("/api/settings", async (c) => {
    const backups: { name: string; createdAt: string; size: number }[] = [];
    if (options.backupDirectory) {
      try {
        for (const name of (await readdir(options.backupDirectory))
          .filter((n) => n.endsWith(".sqlite"))
          .sort()
          .reverse()
          .slice(0, 14)) {
          const file = await stat(join(options.backupDirectory, name));
          backups.push({
            name,
            createdAt: file.mtime.toISOString(),
            size: file.size,
          });
        }
      } catch {
        /* Fresh installations have no snapshots yet. */
      }
    }
    return c.json({
      settings: store.settings(),
      coverage: coverage(),
      latestJob: store.latestJob(),
      backups,
    });
  });
  app.get("/api/settings/jobs", (c) => c.json({ jobs: store.jobs() }));
  app.put("/api/settings", async (c) => {
    const settings = settingsSchema.parse(await c.req.json());
    store.saveSettings(settings);
    return c.json({ settings });
  });
  app.post("/api/sync", async (c) => {
    const input = z
      .object({
        mode: z.enum(["initial", "latest", "missing", "range"]),
        from: z.number().int().min(1).max(10000).optional(),
        to: z.number().int().min(1).max(10000).optional(),
      })
      .parse(await c.req.json());
    if (
      input.mode === "range" &&
      (!input.from || !input.to || input.from > input.to)
    )
      throw new Error("시작·종료 회차를 올바르게 입력해 주세요.");
    return c.json(engine.start(input.mode, input), 202);
  });
  app.get("/api/sync/:id", (c) => {
    const job = store.job(c.req.param("id"));
    return job
      ? c.json(job)
      : c.json({ error: "작업을 찾지 못했습니다." }, 404);
  });
  app.get("/api/backup", (c) =>
    c.json(
      {
        schemaVersion: 2,
        exportedAt: new Date().toISOString(),
        favorites: store.favorites(c.get("user").id),
        purchases: store.tickets(c.get("user").id),
        settings: store.settings(),
      },
      200,
      { "Content-Disposition": 'attachment; filename="lotto-backup.json"' },
    ),
  );
  app.post("/api/backup/snapshot", async (c) => {
    if (!options.backupDirectory)
      throw new Error("서버 백업 경로가 설정되지 않았습니다.");
    await createBackup(store, options.backupDirectory);
    return c.json({ ok: true });
  });
  app.post("/api/backup/restore", async (c) => {
    const input = z
      .object({
        confirmed: z.literal(true),
        backup: z.object({
          schemaVersion: z.union([z.literal(1), z.literal(2)]),
          favorites: z
            .array(
              favoriteSchema.extend({
                id: z.string().uuid(),
                createdAt: z.string().datetime().optional(),
                updatedAt: z.string().datetime().optional(),
              }),
            )
            .max(10000),
          purchases: z
            .array(
              z.object({
                id: z.string().uuid(),
                drawNo: z.number().int().min(1).max(10000),
                drawDate: z.string(),
                memo: z.string().max(2000),
                source: z.enum(["manual", "favorite", "qr"]),
                favoriteId: z.string().uuid().nullable(),
                qrFingerprint: z
                  .string()
                  .regex(/^[a-f0-9]{64}$/)
                  .nullable(),
                createdAt: z.string().datetime().optional(),
                updatedAt: z.string().datetime().optional(),
                games: z
                  .array(
                    gameSchema.extend({ id: z.string().uuid().optional() }),
                  )
                  .min(1)
                  .max(100),
              }),
            )
            .max(10000),
          settings: settingsSchema,
        }),
      })
      .parse(await c.req.json());
    const backup = input.backup;
    const userId = c.get("user").id;
    if (
      new Set(backup.favorites.map((f) => f.id)).size !==
        backup.favorites.length ||
      new Set(backup.purchases.map((t) => t.id)).size !==
        backup.purchases.length
    )
      throw new Error("백업에 중복된 기록 ID가 있습니다.");
    const fingerprints = backup.purchases
      .map((t) => t.qrFingerprint)
      .filter(Boolean);
    if (new Set(fingerprints).size !== fingerprints.length)
      throw new Error("백업에 중복된 복권 QR이 있습니다.");
    for (const t of backup.purchases) {
      if (
        t.drawDate !== (store.draw(t.drawNo)?.drawDate ?? drawDateFor(t.drawNo))
      )
        throw new Error("백업의 회차와 날짜가 일치하지 않습니다.");
      if (
        t.source === "qr" &&
        (!t.qrFingerprint ||
          t.games.some((g) => g.quantity !== 1) ||
          t.games.length > 5)
      )
        throw new Error("QR 구매 기록의 형식이 올바르지 않습니다.");
    }
    if (options.backupDirectory)
      await createBackup(store, options.backupDirectory);
    store.sql.transaction(() => {
      store.sql.prepare("DELETE FROM tickets WHERE user_id=?").run(userId);
      store.sql.prepare("DELETE FROM favorites WHERE user_id=?").run(userId);
      for (const f of backup.favorites)
        store.restoreFavorite(userId, f, f.id, f);
      for (const t of backup.purchases) store.saveTicket(userId, t, t.id, t);
      store.saveSettings(backup.settings);
    })();
    return c.json({
      ok: true,
      favorites: backup.favorites.length,
      purchases: backup.purchases.length,
    });
  });
  app.get("/api/purchases.csv", (c) => {
    const csv = (value: unknown) => {
      let text = value === null || value === undefined ? "" : String(value);
      if (typeof value === "string" && /^[\s]*[=+@-]/.test(text))
        text = "'" + text;
      return '"' + text.replaceAll('"', '""') + '"';
    };
    const lines = [
      [
        "회차",
        "추첨일",
        "게임",
        "번호1",
        "번호2",
        "번호3",
        "번호4",
        "번호5",
        "번호6",
        "구매번호수",
        "결과",
        "등수",
        "세전 당첨금",
        "메모",
      ]
        .map(csv)
        .join(","),
    ];
    for (const ticket of store.tickets(c.get("user").id).map(ticketView))
      ticket.games.forEach((g, i) =>
        lines.push(
          [
            ticket.drawNo,
            ticket.drawDate,
            i + 1,
            ...g.numbers,
            g.quantity,
            ticket.results[i].label,
            ticket.results[i].rank,
            ticket.results[i].prizeTotal,
            ticket.memo,
          ]
            .map(csv)
            .join(","),
        ),
      );
    return c.text("\uFEFF" + lines.join("\r\n"), 200, {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="lotto-purchases.csv"',
    });
  });
  return app;
}
