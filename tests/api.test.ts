import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../server/db.js";
import { hashPassword, tokenHash } from "../server/auth.js";
import { createApp } from "../server/app.js";
import { SyncEngine } from "../server/sync.js";
import { drawDateFor, favoriteLabel } from "../shared/domain.js";
import { draw } from "./fixtures.js";

const password = "unit-test-password!";
const hash = await hashPassword(password);

test("unnamed favorites purchase immediately with the Korean closing-time default", async (t) => {
  t.mock.timers.enable({
    apis: ["Date"],
    now: new Date("2026-10-10T19:59:59+09:00"),
  });
  const h = harness();
  try {
    assert.equal(
      (await h.call("/favorites/unknown/purchase", "POST", {})).status,
      401,
    );
    await h.login();
    const favorite = await (
      await h.call("/favorites", "POST", { numbers: [6, 5, 4, 3, 2, 1] })
    ).json();
    assert.equal(favorite.name, "");
    assert.equal(favoriteLabel(favorite), "1, 2, 3, 4, 5, 6");
    assert.equal(
      (
        await h.call("/favorites/" + favorite.id, "PUT", {
          name: "   ",
          numbers: favorite.numbers,
        })
      ).status,
      200,
    );
    const beforeResponse = await h.call(
      "/favorites/" + favorite.id + "/purchase",
      "POST",
      {},
    );
    assert.equal(beforeResponse.status, 201);
    const before = await beforeResponse.json();
    assert.equal(before.drawNo, 1245);
    assert.equal(before.source, "favorite");
    assert.equal(before.favoriteId, favorite.id);
    assert.equal(before.games.length, 1);
    assert.equal(before.games[0].quantity, 1);
    assert.ok(!("totalCost" in before));
    t.mock.timers.setTime(new Date("2026-10-10T20:00:00+09:00").getTime());
    const after = await (
      await h.call("/favorites/" + favorite.id + "/purchase", "POST", {})
    ).json();
    assert.equal(after.drawNo, 1246);
    assert.equal(after.drawDate, drawDateFor(1246));
    assert.equal(after.results[0].status, "pending");
    await h.call("/favorites/" + favorite.id, "PUT", {
      numbers: [11, 12, 13, 14, 15, 16],
    });
    const tickets = (await (await h.call("/purchases")).json()).tickets;
    assert.equal(tickets.length, 2);
    assert.deepEqual(tickets[0].games[0].numbers, [1, 2, 3, 4, 5, 6]);
    await h.call("/favorites/" + favorite.id, "DELETE");
    assert.equal(
      (await h.call("/favorites/" + favorite.id + "/purchase", "POST", {}))
        .status,
      404,
    );
  } finally {
    h.store.close();
  }
});

test("grouped purchases filter before grouping and never split a round across pages", async () => {
  const h = harness();
  try {
    await h.login();
    async function buy(drawNo: number, quantity = 1) {
      assert.equal(
        (
          await h.call("/purchases", "POST", {
            drawNo,
            drawDate: drawDateFor(drawNo),
            games: [{ numbers: [1, 2, 3, 4, 5, 6], quantity }],
          })
        ).status,
        201,
      );
    }
    for (let i = 0; i < 14; i++) await buy(1245, 2);
    for (let no = 1244; no >= 1232; no--) await buy(no);
    const first = await (await h.call("/purchases?groupBy=draw")).json();
    assert.equal(first.total, 14);
    assert.equal(first.pageSize, 12);
    assert.equal(first.groups.length, 12);
    assert.equal(first.totalGames, 41);
    assert.deepEqual(first.latestRounds, [1245, 1244]);
    assert.equal(first.groups[0].drawNo, 1245);
    assert.equal(first.groups[0].tickets.length, 14);
    assert.equal(first.groups[0].totalGames, 28);
    const second = await (
      await h.call("/purchases?groupBy=draw&page=2")
    ).json();
    assert.deepEqual(
      second.groups.map((g: { drawNo: number }) => g.drawNo),
      [1233, 1232],
    );
    assert.deepEqual(second.latestRounds, first.latestRounds);
    const won = await (
      await h.call("/purchases?groupBy=draw&status=won")
    ).json();
    assert.equal(won.total, 1);
    assert.equal(won.totalGames, 28);
    const round = await (
      await h.call("/purchases?groupBy=draw&drawNo=1244")
    ).json();
    assert.equal(round.groups.length, 1);
    assert.equal(round.groups[0].totalGames, 1);
    assert.deepEqual(round.latestRounds, [1244]);
    const month = await (
      await h.call("/purchases?groupBy=draw&month=2026-10")
    ).json();
    assert.equal(month.total, 2);
    assert.equal(month.totalGames, 29);
    const empty = await (
      await h.call("/purchases?groupBy=draw&drawNo=1")
    ).json();
    assert.deepEqual(empty.groups, []);
    assert.deepEqual(empty.latestRounds, []);
    assert.equal(empty.totalGames, 0);
  } finally {
    h.store.close();
  }
});
class QueuedEngine extends SyncEngine {
  override wake() {}
}
function harness() {
  const store = new Store(":memory:");
  store.bootstrap("textimage", hash);
  store.upsertDraw(draw());
  const app = createApp(store, new QueuedEngine(store), { production: true });
  let cookie = "";
  async function call(
    path: string,
    method = "GET",
    body?: unknown,
    extraHeaders: Record<string, string> = {},
  ) {
    return app.request("https://lotto.mintwool.com/api" + path, {
      method,
      headers: {
        Origin: "https://lotto.mintwool.com",
        ...(cookie ? { Cookie: cookie } : {}),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...extraHeaders,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }
  async function login() {
    const response = await call("/auth/login", "POST", {
      username: "textimage",
      password,
    });
    assert.equal(response.status, 200);
    cookie = response.headers.get("set-cookie")!.split(";")[0];
    return response;
  }
  return { store, call, login, app, getCookie: () => cookie };
}

test("generation API preserves old clients and authenticates all algorithm requests", async () => {
  const h = harness();
  try {
    assert.equal((await h.call("/generate", "POST", {})).status, 401);
    await h.login();
    assert.equal(
      (
        await h.call(
          "/generate",
          "POST",
          {},
          { Origin: "https://outside.example" },
        )
      ).status,
      403,
    );
    const legacy = await h.call("/generate", "POST", {
      included: [7],
      excluded: [1],
    });
    assert.equal(legacy.status, 200);
    const original = await legacy.json();
    assert.equal(original.games.length, 5);
    assert.equal(original.metadata.options.algorithm, "random");
    assert.equal(original.metadata.analysis, null);
    assert.ok(
      original.games.every(
        (game: number[]) => game.includes(7) && !game.includes(1),
      ),
    );
    for (const algorithm of [
      "random",
      "hot",
      "cold",
      "overdue",
      "balanced",
      "statistical",
    ]) {
      const response = await h.call("/generate", "POST", {
        algorithm,
        count: 3,
        included: [7, 22],
        span: "10",
      });
      assert.equal(response.status, 200, algorithm);
      const result = await response.json();
      assert.equal(result.games.length, 3);
      assert.equal(result.metadata.options.algorithm, algorithm);
      assert.equal(
        new Set(result.games.map((game: number[]) => game.join(","))).size,
        3,
      );
    }
    const balance = {
      oddCount: 3,
      ranges: Array.from({ length: 5 }, () => ({ min: 0, max: 2 })),
    };
    const fixed = await h.call("/generate", "POST", {
      algorithm: "hot",
      count: 1,
      included: [1, 2, 11, 12, 21, 22],
      balance,
    });
    assert.equal(fixed.status, 200);
    const result = await fixed.json();
    assert.deepEqual(result.games, [[1, 2, 11, 12, 21, 22]]);
    assert.deepEqual(result.metadata.options.balance, balance);
    assert.equal(result.metadata.possibleCombinations, 1);
    assert.equal(
      (await (await h.call("/favorites")).json()).favorites.length,
      0,
    );
    assert.equal((await (await h.call("/purchases")).json()).tickets.length, 0);
  } finally {
    h.store.close();
  }
});

test("generation API validates shapes, cross-field constraints and reports unavailable data", async () => {
  const h = harness();
  try {
    await h.login();
    for (const body of [
      { algorithm: "unknown" },
      { span: "20" },
      { count: 21 },
      { included: [1, 1] },
      { excluded: [46] },
      { included: [7], excluded: [7] },
      { balance: { oddCount: 3, ranges: [] } },
      {
        balance: {
          oddCount: 7,
          ranges: Array.from({ length: 5 }, () => ({ min: 0, max: 2 })),
        },
      },
      {
        balance: {
          oddCount: null,
          ranges: Array.from({ length: 5 }, () => ({ min: 3, max: 2 })),
        },
      },
      {
        algorithm: "statistical",
        scoreWeights: { frequency: 0, recent: 0, overdue: 0 },
      },
      {
        algorithm: "statistical",
        scoreWeights: { frequency: 101, recent: 0, overdue: 0 },
      },
      { algorithm: "balanced", included: [1, 3, 5, 7] },
      { count: 2, included: [1, 2, 3, 4, 5, 6] },
    ]) {
      const response = await h.call("/generate", "POST", body);
      assert.equal(response.status, 400, JSON.stringify(body));
      assert.ok((await response.json()).error);
    }
    h.store.upsertDraw({ ...draw(1243), status: "numbers_only" });
    const partial = await (
      await h.call("/generate", "POST", {
        algorithm: "statistical",
        scoreWeights: { frequency: 10, recent: 20, overdue: 30 },
      })
    ).json();
    assert.deepEqual(partial.metadata.analysis, {
      span: "100",
      count: 2,
      fromDraw: 1243,
      toDraw: 1245,
      missingCount: 1,
      limited: true,
    });
    assert.equal(partial.metadata.numberScores[0].count, 2);
    assert.equal(partial.metadata.numberScores[6].count, 0);
    h.store.sql.prepare("DELETE FROM draws").run();
    for (const algorithm of ["hot", "cold", "overdue", "statistical"]) {
      const response = await h.call("/generate", "POST", { algorithm });
      assert.equal(response.status, 400);
      assert.match((await response.json()).error, /설정에서 데이터를/);
    }
    for (const algorithm of ["random", "balanced"])
      assert.equal(
        (await h.call("/generate", "POST", { algorithm })).status,
        200,
      );
  } finally {
    h.store.close();
  }
});

test("one account authenticates with secure cookie; protected endpoints and Origin are enforced", async () => {
  const h = harness();
  try {
    assert.equal((await h.call("/favorites")).status, 401);
    assert.equal(
      (
        await h.call(
          "/auth/login",
          "POST",
          { username: "textimage", password },
          { Origin: "https://evil.example" },
        )
      ).status,
      403,
    );
    const response = await h.login();
    const header = response.headers.get("set-cookie")!;
    for (const flag of ["HttpOnly", "Secure", "SameSite=Lax", "Max-Age=604800"])
      assert.ok(header.includes(flag));
    assert.equal((await h.call("/favorites")).status, 200);
    const anonymousSignup = await h.call("/signup", "POST", {
      username: "new",
      password,
    });
    assert.equal(anonymousSignup.status, 404);
    await h.call("/auth/logout", "POST", {});
    assert.equal((await h.call("/favorites")).status, 401);
    assert.equal(
      (
        h.store.sql.prepare("SELECT COUNT(*) AS count FROM users").get() as {
          count: number;
        }
      ).count,
      1,
    );
  } finally {
    h.store.close();
  }
});
test("round search is exact and does not also match digits inside draw dates", async () => {
  const h = harness();
  try {
    h.store.upsertDraw({ ...draw(), drawNo: 1, drawDate: drawDateFor(1) });
    h.store.upsertDraw({ ...draw(), drawNo: 12, drawDate: drawDateFor(12) });
    await h.login();
    const result = await (await h.call("/draws?q=1")).json();
    assert.equal(result.total, 1);
    assert.equal(result.draws[0].drawNo, 1);
    const padded = await (await h.call("/draws?q=001")).json();
    assert.equal(padded.total, 1);
    assert.equal(padded.draws[0].drawNo, 1);
    const dated = await (await h.call("/draws?q=2002.12.07")).json();
    assert.equal(dated.total, 1);
    assert.equal(dated.draws[0].drawNo, 1);
  } finally {
    h.store.close();
  }
});

test("five failed login attempts are limited persistently", async () => {
  const h = harness();
  try {
    for (let i = 0; i < 5; i++)
      assert.equal(
        (
          await h.call("/auth/login", "POST", {
            username: "textimage",
            password: "incorrect",
          })
        ).status,
        401,
      );
    assert.equal(
      (await h.call("/auth/login", "POST", { username: "textimage", password }))
        .status,
      429,
    );
    h.store.sql
      .prepare("UPDATE auth_throttles SET started_at=?")
      .run(Date.now() - 16 * 60000);
    await h.login();
  } finally {
    h.store.close();
  }
});
test("purchase snapshots remain independent of favorite changes/deletion and can still be edited", async () => {
  const h = harness();
  try {
    await h.login();
    const favorite = await (
      await h.call("/favorites", "POST", {
        name: "test combination",
        numbers: [6, 5, 4, 3, 2, 1],
        memo: "original",
      })
    ).json();
    const body = {
      drawNo: 1245,
      drawDate: drawDateFor(1245),
      source: "favorite",
      favoriteId: favorite.id,
      games: [{ numbers: favorite.numbers, quantity: 2 }],
      memo: "copied",
    };
    const ticket = await (await h.call("/purchases", "POST", body)).json();
    assert.ok(!("totalCost" in ticket));
    assert.equal(ticket.confirmedPrize, 6000000000);
    await h.call("/favorites/" + favorite.id, "PUT", {
      name: "changed",
      numbers: [11, 12, 13, 14, 15, 16],
      memo: "",
    });
    await h.call("/favorites/" + favorite.id, "DELETE");
    const current = (await (await h.call("/purchases")).json()).tickets[0];
    assert.deepEqual(current.games[0].numbers, [1, 2, 3, 4, 5, 6]);
    assert.equal(
      (
        await h.call("/purchases/" + ticket.id, "PUT", {
          ...body,
          memo: "edited after deletion",
        })
      ).status,
      200,
    );
    assert.equal(
      (await h.call("/purchases", "POST", { ...body, drawDate: "2026-10-11" }))
        .status,
      400,
    );
    const future = await (
      await h.call("/purchases", "POST", {
        drawNo: 1246,
        drawDate: drawDateFor(1246),
        games: [{ numbers: [1, 2, 3, 4, 5, 6], quantity: 1 }],
      })
    ).json();
    assert.equal(future.results[0].status, "pending");
    assert.equal(future.results[0].prizeTotal, null);
  } finally {
    h.store.close();
  }
});
test("same QR is rejected across URL variants but repeated games inside a ticket remain", async () => {
  const h = harness();
  try {
    await h.login();
    const payload = "1245m010203040506m0102030405060000000011.net";
    const body = {
      drawNo: 1245,
      drawDate: drawDateFor(1245),
      games: [{ numbers: [10, 11, 12, 13, 14, 15], quantity: 1 }],
      source: "qr",
      qrRaw: payload,
    };
    const first = await h.call("/purchases", "POST", body);
    assert.equal(first.status, 201);
    const ticket = await first.json();
    assert.equal(ticket.games.length, 2);
    assert.deepEqual(ticket.games[0].numbers, ticket.games[1].numbers);
    assert.ok(!("totalCost" in ticket));
    const updated = await (
      await h.call("/purchases/" + ticket.id, "PUT", { memo: "QR 메모 수정" })
    ).json();
    assert.equal(updated.memo, "QR 메모 수정");
    assert.deepEqual(updated.games, ticket.games);
    assert.equal(updated.qrFingerprint, ticket.qrFingerprint);
    assert.equal(
      (
        await h.call("/purchases", "POST", {
          ...body,
          qrRaw: "https://www.dhlottery.co.kr/qr.do?v=" + payload,
        })
      ).status,
      409,
    );
    assert.equal(
      (
        await h.call("/purchases", "POST", {
          ...body,
          qrRaw: payload.replace("0011.net", "0012.net"),
        })
      ).status,
      201,
    );
  } finally {
    h.store.close();
  }
});
test("tally correction is reflected on read; history is kept outside purchase totals", async () => {
  const h = harness();
  try {
    await h.login();
    const pending = draw();
    pending.status = "numbers_only";
    pending.ranks.forEach((r) => {
      r.numWinners = null;
      r.prizePerGame = null;
      r.totalPrizeAmount = null;
    });
    h.store.sql.prepare("DELETE FROM draws").run();
    h.store.upsertDraw(pending);
    const ticket = await (
      await h.call("/purchases", "POST", {
        drawNo: 1245,
        drawDate: drawDateFor(1245),
        games: [{ numbers: [1, 2, 3, 4, 8, 9], quantity: 3 }],
      })
    ).json();
    assert.equal(ticket.unsettledGames, 3);
    h.store.upsertDraw(draw());
    const current = (await (await h.call("/purchases")).json()).tickets[0];
    assert.equal(current.confirmedPrize, 150000);
    assert.equal(current.unsettledGames, 0);
    await h.call("/history", "POST", { numbers: [1, 2, 3, 4, 5, 6] });
    const dashboard = await (await h.call("/dashboard?month=2026-10")).json();
    assert.equal(dashboard.confirmedPrize, 150000);
    assert.equal(dashboard.totalGames, 3);
    assert.equal(dashboard.wonGames, 3);
    assert.ok(!("spent" in dashboard));
    assert.ok(!("profit" in dashboard));
  } finally {
    h.store.close();
  }
});
test("JSON backup/restore is atomic and excludes auth; CSV handles formulas", async () => {
  const h = harness();
  try {
    await h.login();
    const body = {
      drawNo: 1245,
      drawDate: drawDateFor(1245),
      games: [{ numbers: [1, 2, 3, 4, 8, 9], quantity: 1 }],
      memo: "=1+2",
    };
    await h.call("/purchases", "POST", body);
    await h.call("/favorites", "POST", {
      name: "saved",
      numbers: [1, 2, 3, 4, 5, 6],
      memo: "",
    });
    const backup = await (await h.call("/backup")).json();
    assert.equal(backup.schemaVersion, 2);
    assert.ok(!JSON.stringify(backup).includes("totalCost"));
    assert.ok(!JSON.stringify(backup).includes("password"));
    assert.ok(!JSON.stringify(backup).includes("session"));
    const csv = await (await h.call("/purchases.csv")).text();
    assert.ok(csv.includes("'=1+2"));
    assert.ok(csv.includes("구매번호수"));
    assert.ok(!csv.includes("구매금액"));
    const corrupt = structuredClone(backup);
    corrupt.purchases[0].games[0].numbers = [1, 1, 2, 3, 4, 5];
    assert.equal(
      (
        await h.call("/backup/restore", "POST", {
          confirmed: true,
          backup: corrupt,
        })
      ).status,
      400,
    );
    assert.equal(
      h.store.tickets(
        (h.store.sql.prepare("SELECT id FROM users").get() as { id: string })
          .id,
      ).length,
      1,
    );
    await h.call("/purchases", "POST", body);
    assert.equal(
      (await h.call("/backup/restore", "POST", { confirmed: true, backup }))
        .status,
      200,
    );
    const restored = await (await h.call("/backup")).json();
    assert.equal(restored.purchases.length, 1);
    assert.deepEqual(restored.favorites, backup.favorites);
    assert.deepEqual(restored.purchases, backup.purchases);
    const legacy = {
      ...backup,
      schemaVersion: 1,
      purchases: backup.purchases.map((ticket: Record<string, unknown>) => ({
        ...ticket,
        totalCost: 1000,
      })),
    };
    assert.equal(
      (
        await h.call("/backup/restore", "POST", {
          confirmed: true,
          backup: legacy,
        })
      ).status,
      200,
    );
    const restoredLegacy = await (await h.call("/backup")).json();
    assert.deepEqual(restoredLegacy.purchases, backup.purchases);
    assert.ok(!JSON.stringify(restoredLegacy).includes("totalCost"));
    assert.equal((await h.call("/auth/session")).status, 200);
  } finally {
    h.store.close();
  }
});
test("password changes verify current password and revoke all existing sessions", async () => {
  const h = harness();
  try {
    await h.login();
    assert.equal(
      (
        await h.call("/auth/password", "POST", {
          currentPassword: "wrong",
          newPassword: "next-password!",
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await h.call("/auth/password", "POST", {
          currentPassword: password,
          newPassword: "next-password!",
        })
      ).status,
      200,
    );
    assert.equal((await h.call("/favorites")).status, 401);
    assert.equal(
      (await h.call("/auth/login", "POST", { username: "textimage", password }))
        .status,
      401,
    );
    assert.equal(
      (
        await h.call("/auth/login", "POST", {
          username: "textimage",
          password: "next-password!",
        })
      ).status,
      200,
    );
  } finally {
    h.store.close();
  }
});
test("manual sync returns 202 with a reusable durable job id", async () => {
  const h = harness();
  try {
    await h.login();
    const first = await h.call("/sync", "POST", { mode: "latest" });
    assert.equal(first.status, 202);
    const job = await first.json();
    const second = await (
      await h.call("/sync", "POST", { mode: "missing" })
    ).json();
    assert.equal(second.id, job.id);
    assert.equal(
      (await (await h.call("/sync/" + job.id)).json()).status,
      "queued",
    );
    assert.equal(
      (await h.call("/sync", "POST", { mode: "range", from: 10, to: 5 }))
        .status,
      400,
    );
  } finally {
    h.store.close();
  }
});
