import test from "node:test";
import assert from "node:assert/strict";
import {
  validateNumbers,
  parseNumbers,
  drawDateFor,
  roundForDate,
  nextPurchaseRound,
  publishedCandidate,
  evaluateGame,
  parseLottoQr,
  generateNumbers,
  lottoTaxRule,
  estimateAfterTaxPrize,
} from "../shared/domain.js";
import { normalizeDraw, Sources } from "../server/sources.js";
import { draw, rawDraw, qrSample } from "./fixtures.js";

test("after-tax estimates use historical exemptions and progressive thresholds", () => {
  assert.equal(estimateAfterTaxPrize(null, "2026-10-10"), null);
  assert.equal(estimateAfterTaxPrize(0, "2002-12-07"), 0);
  assert.equal(estimateAfterTaxPrize(50_000, "2022-12-31"), 50_000);
  assert.equal(estimateAfterTaxPrize(50_001, "2022-12-31"), 39_001);
  assert.equal(estimateAfterTaxPrize(2_000_000, "2023-01-01"), 2_000_000);
  assert.equal(estimateAfterTaxPrize(2_000_001, "2023-01-01"), 1_560_001);
  assert.equal(estimateAfterTaxPrize(113_400, "2002-12-07"), 88_452);
  assert.equal(estimateAfterTaxPrize(1_000_000_000, "2003-12-31"), 780_000_000);
  assert.equal(estimateAfterTaxPrize(1_000_000_000, "2004-01-01"), 725_000_000);
  assert.equal(estimateAfterTaxPrize(1_000_000_000, "2006-12-31"), 725_000_000);
  assert.equal(estimateAfterTaxPrize(1_000_000_000, "2007-01-01"), 703_000_000);
  for (const [date, threshold] of [
    ["2004-01-01", 500_000_000],
    ["2007-01-01", 300_000_000],
  ] as const) {
    assert.equal(
      estimateAfterTaxPrize(threshold - 1, date),
      threshold - 1 - Math.floor(((threshold - 1) * 22) / 100),
    );
    assert.equal(
      estimateAfterTaxPrize(threshold, date),
      (threshold * 78) / 100,
    );
    assert.equal(
      estimateAfterTaxPrize(threshold + 100, date),
      (threshold * 78) / 100 + 67,
    );
  }
  assert.equal(lottoTaxRule("2003-12-31").higherRateThreshold, null);
});

test("numbers are six unique integers, sorted; pasted labels and delimiters work", () => {
  assert.deepEqual(parseNumbers("A. 45, 21 13; 3 2 1"), [1, 2, 3, 13, 21, 45]);
  assert.deepEqual(parseNumbers("  45  21\t13 3 2 1  "), [1, 2, 3, 13, 21, 45]);
  assert.deepEqual(parseNumbers("4 5 25 28 32 42"), [4, 5, 25, 28, 32, 42]);
  for (const input of [
    [1, 1, 2, 3, 4, 5],
    [0, 1, 2, 3, 4, 5],
    [1, 2, 3, 4, 5],
    [1, 2, 3, 4, 5, 46],
    ["1", 2, 3, 4, 5, 6],
    [1, 2, 3, 4, 5, 6.1],
  ])
    assert.throws(() => validateNumbers(input));
  assert.throws(() => parseNumbers("1a 2 3 4 5 6"));
});
test("all rank rules distinguish the bonus and multiply by quantity", () => {
  const source = draw();
  const cases = [
    [1, 2, 3, 4, 5, 6],
    [1, 2, 3, 4, 5, 7],
    [1, 2, 3, 4, 5, 8],
    [1, 2, 3, 4, 7, 8],
    [1, 2, 3, 7, 8, 9],
    [1, 2, 7, 8, 9, 10],
  ];
  for (const [index, numbers] of cases.entries())
    assert.equal(
      evaluateGame(numbers, source, 1245).rank,
      index < 5 ? index + 1 : null,
    );
  assert.equal(evaluateGame(cases[3], source, 1245, 3).prizeTotal, 150000);
  assert.equal(evaluateGame(cases[5], source, 1245).status, "lost");
});
test("historical fourth/fifth prizes and absent winners are preserved", () => {
  const historical = draw(1);
  historical.ranks[0] = {
    rank: 1,
    numWinners: 0,
    prizePerGame: 0,
    totalPrizeAmount: 0,
  };
  historical.ranks[3].prizePerGame = 113400;
  historical.ranks[4].prizePerGame = 10000;
  const normalized = normalizeDraw(rawDraw(historical, "github"), "github", 1);
  assert.equal(normalized.status, "complete");
  assert.equal(
    evaluateGame([1, 2, 3, 4, 8, 9], normalized, 1).prizeTotal,
    113400,
  );
  assert.equal(
    evaluateGame([1, 2, 3, 8, 9, 10], normalized, 1).prizeTotal,
    10000,
  );
  assert.equal(
    evaluateGame([1, 2, 3, 4, 5, 6], normalized, 1).status,
    "unpriced",
  );
  assert.equal(
    evaluateGame([1, 2, 3, 4, 5, 6], normalized, 1).prizeTotal,
    null,
  );
});
test("unpublished, missing and delayed tally results are not zero prizes", () => {
  const now = new Date("2026-10-12T00:00:00Z");
  assert.equal(
    evaluateGame([1, 2, 3, 4, 5, 6], undefined, 1246, 1, now).status,
    "pending",
  );
  assert.equal(
    evaluateGame([1, 2, 3, 4, 5, 6], undefined, 1245, 1, now).status,
    "missing",
  );
  const pending = rawDraw();
  for (let i = 1; i <= 5; i++) {
    pending[`rnk${i}WnNope`] = 0;
    pending[`rnk${i}WnAmt`] = 0;
    pending[`rnk${i}SumWnAmt`] = 0;
  }
  const normalized = normalizeDraw(pending, "official");
  assert.equal(normalized.status, "numbers_only");
  assert.equal(
    evaluateGame([1, 2, 3, 4, 5, 6], normalized, 1245).status,
    "tallying",
  );
  assert.equal(
    evaluateGame([1, 2, 3, 4, 5, 6], normalized, 1245).prizeTotal,
    null,
  );
});
test("round and date linking uses Korean closing and broadcast boundaries", () => {
  assert.equal(drawDateFor(1), "2002-12-07");
  assert.equal(drawDateFor(1245), "2026-10-10");
  assert.equal(roundForDate("2026-10-17"), 1246);
  assert.throws(() => roundForDate("2026-10-18"));
  assert.throws(() => roundForDate("2026-02-31"));
  assert.throws(() => drawDateFor(0));
  assert.equal(nextPurchaseRound(new Date("2026-10-10T19:59:59+09:00")), 1245);
  assert.equal(nextPurchaseRound(new Date("2026-10-10T20:00:00+09:00")), 1246);
  assert.equal(publishedCandidate(new Date("2026-10-10T20:44:59+09:00")), 1244);
  assert.equal(publishedCandidate(new Date("2026-10-10T20:45:00+09:00")), 1245);
});
test("source validation rejects incorrect rounds, dates, bonus and payout values", () => {
  assert.throws(() => normalizeDraw(rawDraw(), "official", 1244));
  assert.throws(() =>
    normalizeDraw({ ...rawDraw(), ltRflYmd: "20261011" }, "official"),
  );
  assert.throws(() => normalizeDraw({ ...rawDraw(), bnsWnNo: 1 }, "official"));
  assert.throws(() =>
    normalizeDraw({ ...rawDraw(), rnk2WnAmt: -1 }, "official"),
  );
});
test("QR supports one to five games, keeps identical games, rejects untrusted/invalid QR", () => {
  assert.equal(parseLottoQr(qrSample).games.length, 5);
  assert.equal(
    parseLottoQr("1245m0102030405060000000001.net").payload,
    parseLottoQr("01245M0102030405060000000001").payload,
  );
  for (let count = 1; count <= 5; count++) {
    const qr = parseLottoQr(
      "1245" + "m010203040506".repeat(count) + "0000000001.net",
    );
    assert.equal(qr.games.length, count);
    assert.deepEqual(qr.games[0].numbers, [1, 2, 3, 4, 5, 6]);
  }
  assert.throws(() => parseLottoQr("1245" + "m010203040506".repeat(6)));
  assert.throws(() =>
    parseLottoQr(
      "https://dhlottery.co.kr.evil.example/qr.do?v=1245m010203040506",
    ),
  );
  assert.throws(() => parseLottoQr("1245m010101040506"));
  assert.throws(() => parseLottoQr("1245m010203040546"));
  assert.throws(() => parseLottoQr("hello"));
});
test("random combinations honor inclusions/exclusions and impossible requests fail", () => {
  const generated = generateNumbers(20, [7, 21], [1, 2, 3]);
  assert.equal(new Set(generated.map((g) => g.join(","))).size, 20);
  for (const numbers of generated) {
    validateNumbers(numbers);
    assert.ok(numbers.includes(7) && numbers.includes(21));
    assert.ok(!numbers.some((n) => [1, 2, 3].includes(n)));
  }
  assert.throws(() => generateNumbers(2, [1, 2, 3, 4, 5, 6]));
  assert.throws(() => generateNumbers(1, [7], [7]));
  assert.throws(() =>
    generateNumbers(
      1,
      [],
      Array.from({ length: 40 }, (_, i) => i + 1),
    ),
  );
});
test("official provider rejects HTML, malformed lists and transient failures retry", async () => {
  const html = new Sources(
    async () =>
      new Response("<html>error</html>", {
        headers: { "content-type": "text/html" },
      }),
    0,
  );
  await assert.rejects(() => html.official(1245));
  const broken = new Sources(
    async () => Response.json({ data: { list: {} } }),
    0,
  );
  await assert.rejects(() => broken.official(1245));
  let attempts = 0;
  const retry = new Sources(async () => {
    if (++attempts === 1) throw new Error("temporary");
    return Response.json({ data: { list: [rawDraw()] } });
  }, 1);
  assert.equal((await retry.official(1245))[0].drawNo, 1245);
  assert.equal(attempts, 2);
});
