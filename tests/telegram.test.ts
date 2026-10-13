import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import sharp from "sharp";
import { QRCodeWriter, BarcodeFormat } from "@zxing/library";
import { Store } from "../server/db.js";
import { createApp } from "../server/app.js";
import { SyncEngine } from "../server/sync.js";
import { issueSession } from "../server/auth.js";
import { purchaseInput } from "../server/records.js";
import {
  TelegramBot,
  telegramConfig,
  type TelegramUpdate,
} from "../server/telegram.js";
import {
  TelegramApi,
  TelegramError,
  MAX_IMAGE_BYTES,
  type TelegramTransport,
} from "../server/telegram-api.js";
import { QrDecoder } from "../server/telegram-qr.js";
import {
  historyMessage,
  roundReport,
  latestDueDraw,
  nextRefresh,
  splitMessage,
} from "../server/telegram-messages.js";
import { draw, qrSample, qrRootSample } from "./fixtures.js";
import { noisyQrPixels } from "./qr-fixtures.js";

class FakeApi implements TelegramTransport {
  sends: string[] = [];
  downloads: string[] = [];
  error: TelegramError | null = null;
  downloadError: TelegramError | null = null;
  webhook = "";
  botId = 100;
  async call<T>(
    method: string,
    parameters: Record<string, unknown> = {},
  ): Promise<T> {
    if (method === "getMe") return { id: this.botId, is_bot: true } as T;
    if (method === "getWebhookInfo") return { url: this.webhook } as T;
    if (method === "sendMessage") {
      if (this.error) {
        const error = this.error;
        this.error = null;
        throw error;
      }
      this.sends.push(String(parameters.text));
      return { message_id: this.sends.length } as T;
    }
    throw new Error("Unexpected method: " + method);
  }
  async download(fileId: string) {
    this.downloads.push(fileId);
    if (this.downloadError) {
      const error = this.downloadError;
      this.downloadError = null;
      throw error;
    }
    return Buffer.from("fake-photo");
  }
}
async function harness(
  date = "2026-10-10T19:00:00+09:00",
  path = ":memory:",
  transport = new FakeApi(),
) {
  const store = new Store(path);
  store.bootstrap("owner", "test-hash");
  const userId = (
    store.sql.prepare("SELECT id FROM users WHERE username='owner'").get() as {
      id: string;
    }
  ).id;
  let time = new Date(date);
  let syncCalls = 0;
  const engine = {
    idle: async () => {},
    start: () => {
      syncCalls++;
      return store.createJob("latest");
    },
  };
  const bot = new TelegramBot(
    store,
    engine,
    {
      token: "100:test-only-token",
      allowedUserId: "42",
      siteUsername: "owner",
      origin: "https://lotto.example",
    },
    transport,
    new QrDecoder(),
    () => time,
    async () => qrSample,
  );
  await bot.initialize();
  const messages = () =>
    (
      store.sql
        .prepare("SELECT text FROM telegram_outbox ORDER BY id")
        .all() as { text: string }[]
    ).map((r) => r.text);
  const ticket = (no = 1245, numbers = [1, 2, 3, 4, 8, 9], quantity = 1) =>
    store.saveTicket(
      userId,
      purchaseInput(
        store,
        {
          drawNo: no,
          drawDate: draw(no).drawDate,
          games: [{ numbers, quantity }],
        },
        userId,
      ),
    );
  const close = async () => {
    await bot.stop();
    store.close();
  };
  return {
    store,
    userId,
    bot,
    api: transport,
    messages,
    ticket,
    close,
    engine,
    setTime: (date: string) => {
      time = new Date(date);
    },
    syncCalls: () => syncCalls,
  };
}
const message = (id: number, text = "1 2 3 4 8 9"): TelegramUpdate => ({
  update_id: id,
  message: { from: { id: 42 }, chat: { id: 42, type: "private" }, text },
});

function legacyReport(
  h: Awaited<ReturnType<typeof harness>>,
  key: "initial" | "final",
  text: string | string[],
  finalQueued: number,
  sentParts = 0,
) {
  const scope = (
    h.store.sql.prepare("SELECT scope FROM telegram_accounts").get() as {
      scope: string;
    }
  ).scope;
  h.store.sql
    .prepare("INSERT INTO telegram_reports VALUES(?,?,?,?,?)")
    .run(scope, 1245, Date.parse("2026-10-10T21:00:00+09:00"), finalQueued, 0);
  const parts = typeof text === "string" ? splitMessage(text) : text;
  parts.forEach((part, i) =>
    h.store.sql
      .prepare(
        "INSERT INTO telegram_outbox(scope,delivery_key,part,text,sent_at,attempts) VALUES(?,?,?,?,?,?)",
      )
      .run(scope, `draw:1245:${key}`, i, part, i < sentParts ? 1 : null, 3),
  );
}

function reportState(h: Awaited<ReturnType<typeof harness>>) {
  return h.store.sql
    .prepare("SELECT final_queued FROM telegram_reports WHERE draw_no=1245")
    .get() as {
    final_queued: number;
  };
}

test("configuration is opt-in, validates IDs and defaults to the site bootstrap username", () => {
  assert.equal(telegramConfig({}, "https://lotto.example"), null);
  assert.throws(() =>
    telegramConfig({ TELEGRAM_ENABLED: "true" }, "https://lotto.example"),
  );
  const config = telegramConfig(
    {
      TELEGRAM_ENABLED: "true",
      TELEGRAM_BOT_TOKEN: "1:" + "x".repeat(30),
      TELEGRAM_ALLOWED_USER_ID: "42",
      BOOTSTRAP_USERNAME: "owner",
    },
    "https://lotto.example/",
  );
  assert.equal(config!.siteUsername, "owner");
  assert.equal(config!.origin, "https://lotto.example");
  assert.throws(() =>
    telegramConfig(
      {
        TELEGRAM_ENABLED: "true",
        TELEGRAM_BOT_TOKEN: "1:" + "x".repeat(30),
        TELEGRAM_ALLOWED_USER_ID: "999999999999999999999",
      },
      "https://lotto.example",
    ),
  );
});

test("only the fixed user's private chat is accepted; unauthorized images are never downloaded", async () => {
  const h = await harness();
  try {
    const wrong = message(1);
    wrong.message!.from!.id = 43;
    const group = message(2);
    group.message!.chat = { id: -10, type: "group" };
    const mismatch = message(3);
    mismatch.message!.chat.id = 43;
    wrong.message!.photo = [{ file_id: "private", width: 10, height: 10 }];
    await h.bot.handleUpdate(wrong);
    await h.bot.handleUpdate(group);
    await h.bot.handleUpdate(mismatch);
    assert.equal(h.messages().length, 0);
    assert.equal(h.api.downloads.length, 0);
    await h.bot.handleUpdate(message(4, "/start"));
    assert.equal(h.messages()[0].split("\n")[0], "Mintwool Lotto Bot!");
    assert.ok(
      h
        .messages()[0]
        .includes(
          "토요일 21시부터 그날 회차의 구매 결과를 확인하고, 모두 확정되면 알려드립니다.",
        ),
    );
    await h.bot.handleUpdate(message(5, "/help"));
    assert.equal(h.messages()[1], h.messages()[0]);
  } finally {
    await h.close();
  }
});

test("history replies use the web API's summary, best three rounds and never create purchases", async () => {
  const h = await harness();
  try {
    for (const no of [1, 2, 3, 4]) h.store.upsertDraw(draw(no));
    await h.bot.handleUpdate(message(1, "1,2,3,4,8,9"));
    const response = h.messages()[0];
    assert.match(response, /대조한 총회차: 4회/);
    assert.ok(!response.includes("과거 대조 결과이며"));
    assert.match(response, /최고 당첨 순위: 4등/);
    assert.match(response, /4등 4회/);
    assert.match(response, /4회 \(/);
    assert.match(response, /2회 \(/);
    assert.ok(!response.includes("1회 ("));
    const app = createApp(h.store, new SyncEngine(h.store));
    const session = issueSession(h.store, h.userId);
    const apiResult = await (
      await app.request("/api/history", {
        method: "POST",
        headers: {
          Origin: "https://lotto.mintwool.com",
          Cookie: `lotto_session=${session}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ numbers: [1, 2, 3, 4, 8, 9] }),
      })
    ).json();
    assert.equal(apiResult.bestRank, 4);
    assert.equal(apiResult.compared, 4);
    assert.equal(h.store.tickets(h.userId).length, 0);
    assert.match(historyMessage(h.store, "1 2 3 4 5 7"), /최고 당첨 순위: 2등/);
  } finally {
    await h.close();
  }
});

test("empty data, no hits and malformed numbers have explicit history replies", async () => {
  const h = await harness();
  try {
    await h.bot.handleUpdate(message(1));
    assert.match(h.messages()[0], /수집된 당첨 기록이 없습니다/);
    assert.match(h.messages()[0], /대조한 총회차: 0회/);
    assert.ok(!h.messages()[0].includes("과거 대조 결과이며"));
    h.store.upsertDraw(draw());
    await h.bot.handleUpdate(message(2, "30 31 32 33 34 35"));
    assert.match(h.messages()[1], /당첨 기록이 없습니다/);
    assert.match(h.messages()[1], /대조한 총회차: 1회/);
    assert.ok(!h.messages()[1].includes("과거 대조 결과이며"));
    for (const [i, text] of [
      "1 1 2 3 4 5",
      "0 1 2 3 4 5",
      "1 2 3",
      "1 2 3 4 5 46",
    ].entries())
      await h.bot.handleUpdate(message(3 + i, text));
    assert.ok(
      h
        .messages()
        .slice(2)
        .every((text) => text.includes("서로 다른 번호 6개")),
    );
  } finally {
    await h.close();
  }
});

test("QR immediately registers all repeated games, shares web duplicate detection and chooses the largest photo", async () => {
  const h = await harness();
  try {
    const photo = message(1);
    delete photo.message!.text;
    photo.message!.photo = [
      { file_id: "small", width: 20, height: 20 },
      { file_id: "large", width: 200, height: 200 },
    ];
    await h.bot.handleUpdate(photo);
    await h.bot.handleUpdate(photo);
    assert.deepEqual(h.api.downloads, ["large"]);
    assert.equal(h.store.tickets(h.userId).length, 1);
    assert.equal(h.store.tickets(h.userId)[0].games.length, 5);
    assert.match(h.messages()[0], /QR 구매 등록 완료/);
    const repeat = structuredClone(photo);
    repeat.update_id = 2;
    await h.bot.handleUpdate(repeat);
    assert.match(h.messages()[1], /이미 등록/);
    assert.throws(
      () =>
        h.store.saveTicket(
          h.userId,
          purchaseInput(
            h.store,
            {
              drawNo: 1171,
              drawDate: draw(1171).drawDate,
              games: [{ numbers: [1, 2, 3, 4, 5, 6] }],
              source: "qr",
              qrRaw: qrSample,
            },
            h.userId,
          ),
        ),
      /UNIQUE/,
    );
  } finally {
    await h.close();
  }
});

test("web QR registration is recognized by the bot and identical games retain quantity one", async () => {
  const store = new Store(":memory:");
  store.bootstrap("owner", "test-hash");
  const user = (
    store.sql.prepare("SELECT id FROM users").get() as { id: string }
  ).id;
  const raw = "1245m010203040506m0102030405060000000011.net";
  const input = purchaseInput(
    store,
    {
      drawNo: 1245,
      drawDate: draw().drawDate,
      games: [{ numbers: [10, 11, 12, 13, 14, 15] }],
      source: "qr",
      qrRaw: raw,
    },
    user,
  );
  const saved = store.saveTicket(user, input);
  assert.deepEqual(
    saved.games.map((g) => ({ numbers: g.numbers, quantity: g.quantity })),
    [
      { numbers: [1, 2, 3, 4, 5, 6], quantity: 1 },
      { numbers: [1, 2, 3, 4, 5, 6], quantity: 1 },
    ],
  );
  const api = new FakeApi();
  const bot = new TelegramBot(
    store,
    { idle: async () => {}, start: () => store.createJob("latest") },
    {
      token: "test",
      allowedUserId: "42",
      siteUsername: "owner",
      origin: "https://lotto.example",
    },
    api,
    new QrDecoder(),
    () => new Date(),
    async () => raw,
  );
  try {
    await bot.initialize();
    const update = message(1);
    update.message!.photo = [
      { file_id: "web-duplicate", width: 100, height: 100 },
    ];
    await bot.handleUpdate(update);
    assert.match(
      (
        store.sql.prepare("SELECT text FROM telegram_outbox").get() as {
          text: string;
        }
      ).text,
      /이미 등록/,
    );
    assert.equal(store.tickets(user).length, 1);
  } finally {
    await bot.stop();
    store.close();
  }
});

test("oversized and unsupported image documents are rejected before downloading", async () => {
  const h = await harness();
  try {
    const large = message(1);
    large.message!.document = {
      file_id: "large",
      mime_type: "image/jpeg",
      file_size: MAX_IMAGE_BYTES + 1,
    };
    const wrong = message(2);
    wrong.message!.document = {
      file_id: "wrong",
      mime_type: "application/pdf",
    };
    await h.bot.handleUpdate(large);
    await h.bot.handleUpdate(wrong);
    assert.deepEqual(h.api.downloads, []);
    assert.match(h.messages()[0], /20MB/);
    assert.match(h.messages()[1], /JPEG/);
  } finally {
    await h.close();
  }
});

test("weekly selection uses the Korean draw date across closing time and UTC midnight", () => {
  for (const value of [
    "2026-10-10T19:59:00+09:00",
    "2026-10-10T20:00:00+09:00",
    "2026-10-10T20:59:59+09:00",
  ])
    assert.equal(latestDueDraw(new Date(value)).drawNo, 1244);
  for (const value of [
    "2026-10-10T21:00:00+09:00",
    "2026-10-11T00:00:00+09:00",
    "2026-10-12T09:00:00+09:00",
  ])
    assert.equal(latestDueDraw(new Date(value)).drawNo, 1245);
  assert.equal(
    nextRefresh(1245, new Date("2026-10-10T21:01:00+09:00")),
    Date.parse("2026-10-10T21:15:00+09:00"),
  );
  assert.equal(
    nextRefresh(1245, new Date("2026-10-11T02:59:00+09:00")),
    Date.parse("2026-10-11T03:00:00+09:00"),
  );
  assert.equal(
    nextRefresh(1245, new Date("2026-10-11T03:00:00+09:00")),
    Date.parse("2026-10-12T03:00:00+09:00"),
  );
});

test("21:00 reports all current-round games, quantities and gross prizes; excludes next-round purchases", async () => {
  const h = await harness();
  try {
    h.store.upsertDraw(draw());
    h.ticket(1245, [1, 2, 3, 4, 8, 9], 3);
    h.ticket(1245, [30, 31, 32, 33, 34, 35]);
    h.ticket(1246, [8, 9, 10, 11, 12, 13]);
    await h.bot.tick();
    assert.equal(h.api.sends.length, 0);
    h.setTime("2026-10-10T21:00:00+09:00");
    await h.bot.tick();
    await delay(0);
    assert.equal(h.api.sends.length, 1);
    const report = h.api.sends[0];
    assert.match(report, /제1245회/);
    assert.match(report, /확정 구매 결과/);
    assert.match(report, /구매번호수: 4개/);
    assert.match(report, /확정 세전 당첨금: 150,000원/);
    assert.match(report, /4등 · 4등 당첨 · 150,000원/);
    assert.match(report, /낙첨/);
    assert.match(report, /×3/);
    assert.ok(!report.includes("8 9 10 11 12 13"));
    await h.bot.tick();
    assert.equal(h.api.sends.length, 1);
    assert.equal(h.syncCalls(), 0);
  } finally {
    await h.close();
  }
});

test("missing results and numbers only stay silent until one complete report is sent", async () => {
  const h = await harness();
  try {
    h.ticket();
    h.store.saveSettings({ autoSync: false });
    h.setTime("2026-10-10T21:00:00+09:00");
    await h.bot.tick();
    await delay(0);
    assert.equal(h.api.sends.length, 0);
    assert.equal(h.messages().length, 0);
    const partial = draw();
    partial.status = "numbers_only";
    partial.ranks.forEach((r) => {
      r.prizePerGame = null;
      r.numWinners = null;
    });
    h.store.upsertDraw(partial);
    await h.bot.tick();
    assert.equal(h.api.sends.length, 0);
    h.setTime("2026-10-10T21:15:00+09:00");
    await h.bot.tick();
    await delay(0);
    assert.equal(h.syncCalls(), 2);
    h.store.upsertDraw(draw());
    await h.bot.tick();
    assert.equal(h.api.sends.length, 1);
    assert.match(h.api.sends[0], /확정 구매 결과/);
    assert.match(h.api.sends[0], /확정 세전 당첨금: 50,000원/);
    assert.ok(!/미확정|집계 중/.test(h.api.sends[0]));
    const syncCalls = h.syncCalls();
    h.setTime("2026-10-12T03:00:00+09:00");
    await h.bot.tick();
    await delay(0);
    assert.equal(h.api.sends.length, 1);
    assert.equal(h.syncCalls(), syncCalls);
  } finally {
    await h.close();
  }
});

test("numbers-only report shows known ranks without presenting unconfirmed payouts as final zero", async () => {
  const h = await harness();
  try {
    const partial = draw();
    partial.status = "numbers_only";
    h.store.upsertDraw(partial);
    h.ticket();
    const report = roundReport(
      h.store,
      h.userId,
      1245,
      "https://lotto.example",
      new Date("2026-10-10T21:00:00+09:00"),
    );
    assert.match(report, /당첨금 집계 중/);
    assert.match(report, /4등/);
    assert.match(report, /미확정 1개 별도/);
    assert.ok(!report.includes("50,000원"));
  } finally {
    await h.close();
  }
});

test("complete draws with tallying or unpriced purchased games wait for settlement", async () => {
  for (const payout of [null, 0]) {
    const h = await harness();
    try {
      h.ticket();
      const incomplete = draw();
      const rank = incomplete.ranks.find((r) => r.rank === 4)!;
      rank.prizePerGame = payout;
      h.store.upsertDraw(incomplete);
      h.setTime("2026-10-10T21:00:00+09:00");
      await h.bot.tick();
      await delay(0);
      assert.equal(h.api.sends.length, 0);
      assert.equal(h.messages().length, 0);
      assert.equal(reportState(h).final_queued, 0);
      assert.equal(h.syncCalls(), 1);
      h.store.upsertDraw(draw());
      await h.bot.tick();
      assert.equal(h.api.sends.length, 1);
      assert.match(h.api.sends[0], /확정 세전 당첨금: 50,000원/);
    } finally {
      await h.close();
    }
  }
});

test("legacy intermediate replies are canceled whether unsent or already sent", async () => {
  for (const sentParts of [0, 1]) {
    const h = await harness();
    try {
      h.ticket();
      legacyReport(
        h,
        "initial",
        roundReport(h.store, h.userId, 1245, h.bot.config.origin, new Date()),
        0,
        sentParts,
      );
      h.setTime("2026-10-10T21:00:00+09:00");
      await h.bot.initialize();
      await h.bot.flush();
      assert.equal(h.api.sends.length, 0);
      assert.equal(h.messages().length, sentParts);
      await h.bot.handleUpdate(message(1, "/help"));
      await h.bot.flush();
      assert.match(h.api.sends[0], /Mintwool Lotto Bot!/);
      h.store.upsertDraw(draw());
      await h.bot.tick();
      assert.equal(h.api.sends.length, 2);
      assert.match(h.api.sends[1], /확정 구매 결과/);
      await h.bot.initialize();
      await h.bot.tick();
      assert.equal(h.api.sends.length, 2);
    } finally {
      await h.close();
    }
  }
});

test("legacy settled initial and final reports preserve completed deliveries", async () => {
  for (const key of ["initial", "final"] as const) {
    const h = await harness();
    try {
      h.store.upsertDraw(draw());
      h.ticket();
      legacyReport(
        h,
        key,
        roundReport(
          h.store,
          h.userId,
          1245,
          h.bot.config.origin,
          new Date(),
          key === "final",
        ),
        1,
        1,
      );
      h.setTime("2026-10-10T21:00:00+09:00");
      await h.bot.initialize();
      await h.bot.tick();
      assert.equal(h.api.sends.length, 0);
      assert.equal(h.messages().length, 1);
      assert.equal(h.syncCalls(), 0);
      assert.equal(reportState(h).final_queued, 1);
    } finally {
      await h.close();
    }
  }
});

test("legacy unsent settled reports keep their delivery and retry metadata", async () => {
  for (const key of ["initial", "final"] as const) {
    const h = await harness();
    try {
      h.store.upsertDraw(draw());
      h.ticket();
      legacyReport(
        h,
        key,
        roundReport(
          h.store,
          h.userId,
          1245,
          h.bot.config.origin,
          new Date(),
          key === "final",
        ),
        1,
      );
      h.setTime("2026-10-10T21:00:00+09:00");
      h.store.sql
        .prepare("UPDATE telegram_outbox SET next_attempt_at=?")
        .run(Date.parse("2026-10-10T21:00:30+09:00"));
      await h.bot.initialize();
      await h.bot.tick();
      assert.equal(h.api.sends.length, 0);
      const row = h.store.sql
        .prepare(
          "SELECT delivery_key,attempts,next_attempt_at FROM telegram_outbox",
        )
        .get() as {
        delivery_key: string;
        attempts: number;
        next_attempt_at: number;
      };
      assert.equal(row.delivery_key, "draw:1245:final");
      assert.equal(row.attempts, 3);
      assert.equal(
        row.next_attempt_at,
        Date.parse("2026-10-10T21:00:30+09:00"),
      );
      h.setTime("2026-10-10T21:00:30+09:00");
      await h.bot.flush();
      assert.equal(h.api.sends.length, 1);
      assert.match(h.api.sends[0], /확정 구매 결과/);
      assert.match(h.api.sends[0], /50,000원/);
    } finally {
      await h.close();
    }
  }
});

test("legacy finals defer on restart and rebuild stale intermediate text once ready", async () => {
  for (const readyAtRestart of [false, true]) {
    const h = await harness();
    try {
      h.ticket();
      legacyReport(
        h,
        "final",
        roundReport(
          h.store,
          h.userId,
          1245,
          h.bot.config.origin,
          new Date(),
          true,
        ),
        1,
      );
      if (readyAtRestart) h.store.upsertDraw(draw());
      h.setTime("2026-10-10T21:00:00+09:00");
      await h.bot.initialize();
      await h.bot.flush();
      assert.equal(h.api.sends.length, 0);
      assert.equal(h.messages().length, 0);
      assert.equal(reportState(h).final_queued, 0);
      h.store.upsertDraw(draw());
      await h.bot.tick();
      assert.equal(h.api.sends.length, 1);
      assert.match(h.api.sends[0], /50,000원/);
      assert.ok(!/미수집|미확정|집계 중/.test(h.api.sends[0]));
    } finally {
      await h.close();
    }
  }
});

test("delivery rechecks settlement after queueing and does not block ordinary replies", async () => {
  const h = await harness();
  try {
    h.ticket();
    h.store.upsertDraw(draw());
    h.setTime("2026-10-10T21:00:00+09:00");
    h.api.error = new TelegramError(429, 30);
    await h.bot.tick();
    assert.equal(reportState(h).final_queued, 1);
    const incomplete = draw();
    incomplete.ranks.find((rank) => rank.rank === 4)!.numWinners = null;
    h.store.upsertDraw(incomplete);
    h.setTime("2026-10-10T21:00:30+09:00");
    await h.bot.handleUpdate(message(1, "/help"));
    await h.bot.flush();
    assert.equal(h.api.sends.length, 1);
    assert.match(h.api.sends[0], /Mintwool Lotto Bot!/);
    assert.equal(reportState(h).final_queued, 0);
    h.store.upsertDraw(draw());
    await h.bot.tick();
    assert.equal(h.api.sends.length, 2);
    assert.match(h.api.sends[1], /확정 구매 결과/);
  } finally {
    await h.close();
  }
});

test("deferred multipart finals survive restart without resending successful parts", async () => {
  const h = await harness();
  try {
    h.store.upsertDraw(draw());
    h.store.saveTicket(
      h.userId,
      purchaseInput(
        h.store,
        {
          drawNo: 1245,
          drawDate: draw().drawDate,
          games: Array.from({ length: 100 }, () => ({
            numbers: [1, 2, 3, 4, 8, 9],
          })),
        },
        h.userId,
      ),
    );
    const text = roundReport(
      h.store,
      h.userId,
      1245,
      h.bot.config.origin,
      new Date(),
      true,
    );
    const parts = splitMessage(text);
    assert.ok(parts.length > 1);
    legacyReport(h, "final", parts, 1, 1);
    const partial = draw();
    partial.ranks.find((rank) => rank.rank === 4)!.numWinners = null;
    h.store.upsertDraw(partial);
    h.setTime("2026-10-10T21:00:00+09:00");
    await h.bot.initialize();
    assert.equal(reportState(h).final_queued, 0);
    assert.equal(h.messages().length, 1);
    h.store.upsertDraw(draw());
    await h.bot.initialize();
    await h.bot.tick();
    assert.deepEqual(h.api.sends, parts.slice(1));
    assert.equal(h.messages().length, parts.length);
    await h.bot.initialize();
    await h.bot.tick();
    assert.equal(h.api.sends.length, parts.length - 1);
  } finally {
    await h.close();
  }
});

test("no purchases waits for complete draw numbers; first activation never sends historical reports", async () => {
  const h = await harness("2026-10-12T09:00:00+09:00");
  try {
    h.store.upsertDraw(draw());
    await h.bot.tick();
    assert.equal(h.messages().length, 0);
    const partial = draw(1246);
    partial.status = "numbers_only";
    h.store.upsertDraw(partial);
    h.setTime("2026-10-17T21:00:00+09:00");
    await h.bot.tick();
    await delay(0);
    assert.equal(h.api.sends.length, 0);
    h.store.upsertDraw(draw(1246));
    await h.bot.tick();
    assert.match(h.api.sends[0], /등록된 구매내역 없음/);
    assert.match(h.api.sends[0], /당첨번호: 1 2 3 4 5 6/);
  } finally {
    await h.close();
  }
});

test("restart catches up only the most recent Saturday and restores inbox/outbox/report state", async () => {
  const directory = mkdtempSync(join(tmpdir(), "lotto-telegram-"));
  const path = join(directory, "lotto.sqlite");
  try {
    const first = await harness("2026-10-01T09:00:00+09:00", path);
    await first.bot.handleUpdate(message(1, "/help"));
    await first.close();
    const second = await harness("2026-10-12T09:00:00+09:00", path);
    await second.bot.handleUpdate(message(1, "/help"));
    assert.equal(second.messages().length, 1);
    await second.bot.tick();
    const reports = second.store.sql
      .prepare("SELECT draw_no FROM telegram_reports")
      .all() as { draw_no: number }[];
    assert.deepEqual(
      reports.map((r) => r.draw_no),
      [1245],
    );
    assert.equal(second.messages().length, 1);
    second.store.upsertDraw(draw());
    await second.bot.tick();
    await second.close();
    const third = await harness("2026-10-12T09:00:00+09:00", path);
    try {
      await third.bot.tick();
      assert.equal(third.api.sends.length, 0);
      assert.equal(third.messages().length, 2);
    } finally {
      await third.close();
    }
  } finally {
    if (dirname(resolve(directory)) === resolve(tmpdir()))
      rmSync(directory, { recursive: true, force: true });
  }
});

test("flood-control retry resumes unsent parts and never resends recorded successes", async () => {
  const h = await harness();
  try {
    await h.bot.handleUpdate(message(1, "/help"));
    h.api.error = new TelegramError(429, 30);
    await h.bot.flush();
    assert.equal(h.api.sends.length, 0);
    h.setTime("2026-10-10T19:00:29+09:00");
    await h.bot.flush();
    assert.equal(h.api.sends.length, 0);
    h.setTime("2026-10-10T19:00:30+09:00");
    await h.bot.flush();
    await h.bot.flush();
    assert.equal(h.api.sends.length, 1);
  } finally {
    await h.close();
  }
});

test("blocked recipients pause deliveries until authorized /start", async () => {
  const h = await harness();
  try {
    await h.bot.handleUpdate(message(1, "/help"));
    h.api.error = new TelegramError(403);
    await h.bot.flush();
    await h.bot.flush();
    assert.equal(h.api.sends.length, 0);
    await h.bot.handleUpdate(message(2, "/start"));
    await h.bot.flush();
    assert.equal(h.api.sends.length, 2);
  } finally {
    await h.close();
  }
});

test("another fixed user or bot cannot receive previous outbox messages", async () => {
  const h = await harness();
  try {
    await h.bot.handleUpdate(message(1, "/help"));
    const api = new FakeApi();
    const other = new TelegramBot(
      h.store,
      h.engine,
      {
        ...h.bot.config,
        allowedUserId: "43",
      },
      api,
    );
    try {
      await other.initialize();
      await other.flush();
      assert.equal(api.sends.length, 0);
    } finally {
      await other.stop();
    }
  } finally {
    await h.close();
  }
});

test("existing webhook prevents polling startup", async () => {
  const store = new Store(":memory:");
  store.bootstrap("owner", "hash");
  const api = new FakeApi();
  api.webhook = "https://old.example/webhook";
  const bot = new TelegramBot(
    store,
    { idle: async () => {}, start: () => store.createJob("latest") },
    {
      token: "test",
      allowedUserId: "42",
      siteUsername: "owner",
      origin: "https://lotto.example",
    },
    api,
  );
  try {
    await assert.rejects(bot.initialize(), /webhook/);
  } finally {
    await bot.stop();
    store.close();
  }
});

test("long results split at complete game rows, with every message below 3500 characters", () => {
  const rows = Array.from(
    { length: 400 },
    (_, i) =>
      `복권 ${i + 1} / 게임 1: 1 2 3 4 5 6 ×1000 → 1등 당첨 · 3,000,000,000원`,
  );
  const parts = splitMessage(rows.join("\n"));
  assert.ok(parts.length > 1);
  assert.ok(parts.every((p) => p.length <= 3500));
  assert.deepEqual(
    parts.flatMap((p) => p.split("\n").slice(1)),
    rows,
  );
});

test("Telegram transport redacts secret URLs and honours response error codes", async () => {
  const token = "secret-token-never-log";
  const api = new TelegramApi(token, (async () => {
    throw new Error(`https://api.telegram.org/bot${token}/getMe`);
  }) as typeof fetch);
  await assert.rejects(
    api.call("getMe"),
    (e) =>
      e instanceof TelegramError && e.code === 0 && !String(e).includes(token),
  );
  const limited = new TelegramApi(
    token,
    (async () =>
      new Response(
        JSON.stringify({
          ok: false,
          error_code: 429,
          description: token,
          parameters: { retry_after: 15 },
        }),
        { status: 429 },
      )) as typeof fetch,
  );
  await assert.rejects(
    limited.call("sendMessage"),
    (e) =>
      e instanceof TelegramError &&
      e.retryAfter === 15 &&
      !String(e).includes(token),
  );
});

test("file download checks metadata and streamed bytes, without following QR URLs", async () => {
  const oversize = new TelegramApi(
    "test",
    (async () =>
      new Response(
        JSON.stringify({
          ok: true,
          result: { file_size: MAX_IMAGE_BYTES + 1 },
        }),
      )) as typeof fetch,
  );
  await assert.rejects(oversize.download("file"), /20MB/);
  const unsafe = new TelegramApi(
    "test",
    (async () =>
      new Response(
        JSON.stringify({ ok: true, result: { file_path: "../secret" } }),
      )) as typeof fetch,
  );
  await assert.rejects(unsafe.download("file"), TelegramError);
  let calls = 0;
  const stream = new TelegramApi("test", (async () => {
    if (++calls === 1)
      return new Response(
        JSON.stringify({ ok: true, result: { file_path: "photos/image.jpg" } }),
      );
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(MAX_IMAGE_BYTES));
          controller.enqueue(new Uint8Array(1));
          controller.close();
        },
      }),
    );
  }) as typeof fetch);
  await assert.rejects(stream.download("file"), /20MB/);
});

test("purchase, response and cursor are atomic when queuing a QR reply fails", async () => {
  const h = await harness();
  try {
    const photo = message(1);
    photo.message!.photo = [{ file_id: "atomic", width: 100, height: 100 }];
    h.store.sql.exec(
      "CREATE TRIGGER fail_reply BEFORE INSERT ON telegram_outbox BEGIN SELECT RAISE(ABORT, 'test failure'); END;",
    );
    await assert.rejects(h.bot.handleUpdate(photo), /test failure/);
    assert.equal(h.store.tickets(h.userId).length, 0);
    assert.equal(
      (
        h.store.sql
          .prepare("SELECT next_update_id FROM telegram_state")
          .get() as { next_update_id: number }
      ).next_update_id,
      0,
    );
    h.store.sql.exec("DROP TRIGGER fail_reply");
    await h.bot.handleUpdate(photo);
    assert.equal(h.store.tickets(h.userId).length, 1);
    assert.equal(h.messages().length, 1);
  } finally {
    await h.close();
  }
});

test("transient image downloads retry the same update; a permanently unavailable file receives a reply", async () => {
  const h = await harness();
  try {
    const photo = message(1);
    photo.message!.photo = [{ file_id: "retry", width: 100, height: 100 }];
    h.api.downloadError = new TelegramError(0);
    await assert.rejects(h.bot.handleUpdate(photo), TelegramError);
    assert.equal(h.messages().length, 0);
    await h.bot.handleUpdate(photo);
    assert.equal(h.store.tickets(h.userId).length, 1);
    photo.update_id = 2;
    h.api.downloadError = new TelegramError(400);
    await h.bot.handleUpdate(photo);
    assert.match(h.messages()[1], /사진 파일을 내려받지 못/);
    await h.bot.handleUpdate(photo);
    assert.equal(h.messages().length, 2);
  } finally {
    await h.close();
  }
});

test("the bot waits for an existing sync and requests latest even with site auto-sync disabled", async () => {
  const h = await harness();
  let release!: () => void;
  const existing = new Promise<void>((resolve) => {
    release = resolve;
  });
  h.engine.idle = () => existing;
  try {
    h.store.saveSettings({ autoSync: false });
    h.setTime("2026-10-10T21:00:00+09:00");
    await h.bot.tick();
    assert.equal(h.syncCalls(), 0);
    release();
    await delay(0);
    assert.equal(h.syncCalls(), 1);
  } finally {
    release();
    await h.close();
  }
});

test("pending results switch from fifteen-minute retries to daily 03:00 retries", async () => {
  const h = await harness();
  try {
    h.setTime("2026-10-10T21:00:00+09:00");
    await h.bot.tick();
    await delay(0);
    h.setTime("2026-10-11T03:00:00+09:00");
    await h.bot.tick();
    await delay(0);
    assert.equal(h.syncCalls(), 2);
    h.setTime("2026-10-12T02:59:00+09:00");
    await h.bot.tick();
    await delay(0);
    assert.equal(h.syncCalls(), 2);
    h.setTime("2026-10-12T03:00:00+09:00");
    await h.bot.tick();
    await delay(0);
    assert.equal(h.syncCalls(), 3);
    assert.equal(h.api.sends.length, 0);
  } finally {
    await h.close();
  }
});

test("long polling advances the durable offset and stops without retaining an active timer", async () => {
  class PollApi extends FakeApi {
    offsets: number[] = [];
    override async call<T>(
      method: string,
      parameters: Record<string, unknown> = {},
      signal?: AbortSignal,
    ): Promise<T> {
      if (method !== "getUpdates") return super.call<T>(method, parameters);
      this.offsets.push(Number(parameters.offset));
      if (this.offsets.length === 1)
        return [message(1, "/start"), message(2)] as T;
      return await new Promise<T>((resolve) => {
        if (signal?.aborted) resolve([] as T);
        else
          signal?.addEventListener("abort", () => resolve([] as T), {
            once: true,
          });
      });
    }
  }
  const api = new PollApi();
  const h = await harness("2026-10-10T19:00:00+09:00", ":memory:", api);
  try {
    await h.bot.start();
    for (let attempt = 0; attempt < 100 && api.offsets.length < 2; attempt++)
      await delay(5);
    assert.deepEqual(api.offsets, [0, 3]);
    assert.equal(h.messages().length, 2);
    await h.bot.stop();
    await h.bot.tick();
    assert.deepEqual(api.offsets, [0, 3]);
  } finally {
    await h.close();
  }
});

test("another bot ID uses a separate cursor and cannot deliver the first bot's outbox", async () => {
  const h = await harness();
  try {
    await h.bot.handleUpdate(message(100, "/help"));
    const api = new FakeApi();
    api.botId = 200;
    const other = new TelegramBot(h.store, h.engine, h.bot.config, api);
    try {
      await other.initialize();
      await other.flush();
      assert.equal(api.sends.length, 0);
      await other.handleUpdate(message(1, "/help"));
      assert.equal(h.messages().length, 2);
    } finally {
      await other.stop();
    }
  } finally {
    await h.close();
  }
});

async function qrImage(raw = qrSample) {
  const matrix = new QRCodeWriter().encode(
    raw,
    BarcodeFormat.QR_CODE,
    700,
    700,
    new Map(),
  );
  const pixels = Buffer.alloc(matrix.getWidth() * matrix.getHeight(), 255);
  for (let y = 0; y < matrix.getHeight(); y++)
    for (let x = 0; x < matrix.getWidth(); x++)
      if (matrix.get(x, y)) pixels[y * matrix.getWidth() + x] = 0;
  return sharp(pixels, {
    raw: { width: matrix.getWidth(), height: matrix.getHeight(), channels: 1 },
  })
    .png()
    .toBuffer();
}
test("QR worker enforces file/pixel/time limits and terminates during shutdown", async () => {
  const decoder = new QrDecoder();
  try {
    await assert.rejects(
      decoder.decode(Buffer.alloc(MAX_IMAGE_BYTES + 1)),
      /20MB/,
    );
    const tooManyPixels = await sharp({
      create: { width: 6500, height: 6500, channels: 3, background: "white" },
    })
      .png()
      .toBuffer();
    await assert.rejects(decoder.decode(tooManyPixels), /4천만 픽셀/);
    const pending = decoder.decode(await qrImage());
    const rejected = assert.rejects(pending, /중단/);
    await decoder.stop();
    await rejected;
  } finally {
    await decoder.stop();
  }
  const timed = new QrDecoder(1);
  try {
    await assert.rejects(timed.decode(await qrImage()), /시간이 초과/);
  } finally {
    await timed.stop();
  }
});
test("real worker decodes PNG, JPEG and rotated photos; rejects blank/corrupt/invalid QR", async () => {
  const decoder = new QrDecoder();
  try {
    const png = await qrImage();
    assert.equal(await decoder.decode(png), qrSample);
    assert.equal(
      await decoder.decode(await qrImage(qrRootSample)),
      qrRootSample,
    );
    const jpeg = await sharp(png).rotate(90).jpeg({ quality: 90 }).toBuffer();
    assert.equal(await decoder.decode(jpeg), qrSample);
    const exif = await sharp(png)
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer();
    assert.equal(await decoder.decode(exif), qrSample);
    const invalidQr = await decoder.decode(
      await qrImage("https://evil.example/qr.do?v=1245m010203040506"),
    );
    const store = new Store(":memory:");
    try {
      assert.throws(
        () =>
          purchaseInput(
            store,
            {
              drawNo: 1245,
              drawDate: draw().drawDate,
              source: "qr",
              qrRaw: invalidQr,
              games: [{ numbers: [1, 2, 3, 4, 5, 6] }],
            },
            "owner",
          ),
        /동행복권/,
      );
    } finally {
      store.close();
    }
    await assert.rejects(
      decoder.decode(
        await sharp({
          create: { width: 200, height: 200, channels: 3, background: "white" },
        })
          .png()
          .toBuffer(),
      ),
      /QR을 읽지 못/,
    );
    await assert.rejects(
      decoder.decode(Buffer.from("not-an-image")),
      /사진을 처리하지 못/,
    );
  } finally {
    await decoder.stop();
  }
});

test("QR worker recovers a textured photo through the same denoising used by the browser", async () => {
  const { pixels, width, height } = noisyQrPixels();
  const photo = await sharp(Buffer.from(pixels), {
    raw: { width, height, channels: 1 },
  })
    .png()
    .toBuffer();
  const decoder = new QrDecoder();
  try {
    assert.equal(await decoder.decode(photo), qrRootSample);
  } finally {
    await decoder.stop();
  }
});
