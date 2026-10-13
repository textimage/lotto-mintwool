import test from "node:test";
import assert from "node:assert/strict";
import { generateNumbers, validateNumbers } from "../shared/domain.js";
import {
  GENERATION_ALGORITHMS,
  defaultBalance,
  generateCombinations,
  generationStatistics,
  type BalanceOptions,
  type GenerationAlgorithm,
} from "../shared/generator.js";
import { draw } from "./fixtures.js";

const history = Array.from({ length: 25 }, (_, i) => ({
  ...draw(100 - i),
  numbers: Array.from({ length: 6 }, (_, j) => ((i * 3 + j) % 45) + 1),
}));
function seeded(seed = 17) {
  return () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 0x100000000;
  };
}
const excludeOutside = (pool: number[]) =>
  Array.from({ length: 45 }, (_, i) => i + 1).filter((n) => !pool.includes(n));
const unrestricted = (): BalanceOptions => ({
  oddCount: null,
  ranges: Array.from({ length: 5 }, () => ({ min: 0, max: 6 })),
});
function combinations(pool: number[], size: number): number[][] {
  if (size === 0) return [[]];
  return pool.flatMap((number, index) =>
    combinations(pool.slice(index + 1), size - 1).map((rest) => [
      number,
      ...rest,
    ]),
  );
}
const keys = (games: number[][]) => games.map((g) => g.join(",")).sort();

test("all six algorithms respect inclusions, exclusions, ordering and unique games", () => {
  for (const { id, requiresHistory } of GENERATION_ALGORITHMS) {
    const result = generateCombinations(
      { algorithm: id, count: 20, included: [22, 7], excluded: [1, 3, 13] },
      history,
      seeded(),
    );
    assert.equal(result.games.length, 20, id);
    assert.equal(new Set(keys(result.games)).size, 20, id);
    assert.equal(result.metadata.options.algorithm, id);
    assert.equal(Boolean(result.metadata.analysis), requiresHistory);
    for (const [index, numbers] of result.games.entries()) {
      assert.deepEqual(numbers, validateNumbers(numbers));
      assert.ok(numbers.includes(7) && numbers.includes(22));
      assert.ok(!numbers.some((n) => [1, 3, 13].includes(n)));
      assert.equal(
        result.details[index].rangeCounts.reduce((a, b) => a + b, 0),
        6,
      );
      if (id === "balanced") {
        assert.equal(result.details[index].oddCount, 3);
        assert.ok(
          result.details[index].rangeCounts.every((count) => count <= 2),
        );
      }
    }
  }
});

test("DP capacities match independent exhaustive enumeration, including all feasible results", () => {
  const pool = [1, 2, 3, 11, 12, 21, 22, 31];
  const balance: BalanceOptions = {
    oddCount: 3,
    ranges: [
      { min: 1, max: 2 },
      { min: 1, max: 2 },
      { min: 1, max: 2 },
      { min: 0, max: 1 },
      { min: 0, max: 0 },
    ],
  };
  const expected = combinations(pool, 6).filter(
    (game) =>
      game.includes(2) &&
      game.filter((n) => n % 2).length === 3 &&
      balance.ranges.every(({ min, max }, i) => {
        const count = game.filter((n) => Math.floor((n - 1) / 10) === i).length;
        return count >= min && count <= max;
      }),
  );
  assert.ok(expected.length > 1 && expected.length <= 20);
  for (const { id } of GENERATION_ALGORITHMS) {
    for (const random of [() => 0, () => 1 - Number.EPSILON, seeded()]) {
      const result = generateCombinations(
        {
          algorithm: id,
          count: expected.length,
          included: [2],
          excluded: excludeOutside(pool),
          balance,
        },
        history,
        random,
      );
      assert.equal(result.metadata.possibleCombinations, expected.length);
      assert.deepEqual(keys(result.games), keys(expected));
    }
    assert.throws(
      () =>
        generateCombinations(
          {
            algorithm: id,
            count: expected.length + 1,
            included: [2],
            excluded: excludeOutside(pool),
            balance,
          },
          history,
        ),
      /최대/,
    );
  }
  assert.equal(
    generateCombinations({ count: 1 }).metadata.possibleCombinations,
    8145060,
  );
  assert.equal(
    generateCombinations({ algorithm: "balanced", count: 1 }).metadata
      .possibleCombinations,
    1459200,
  );
});

test("conditional first-branch probabilities equal brute-force product weights", () => {
  const pool = [1, 2, 3, 4, 6, 7, 8, 9];
  const balance = { ...unrestricted(), oddCount: 3 };
  const input = {
    count: 1,
    included: [1, 2, 3, 4],
    excluded: excludeOutside(pool),
    balance,
  };
  const valid = combinations([6, 7, 8, 9], 2).filter(
    (pair) => pair.filter((n) => n % 2).length === 1,
  );
  for (const { id } of GENERATION_ALGORITHMS) {
    const baseline = generateCombinations(
      { ...input, algorithm: id },
      history,
      () => 0,
    );
    const weights = new Map(
      baseline.metadata.numberScores.map((n) => [n.number, n.weight]),
    );
    const mass = (pair: number[]) =>
      pair.reduce((product, n) => product * (weights.get(n) ?? 1), 1);
    const total = valid.reduce((sum, pair) => sum + mass(pair), 0);
    const threshold =
      valid
        .filter((pair) => pair.includes(6))
        .reduce((sum, pair) => sum + mass(pair), 0) / total;
    for (const offset of [-1e-9, 1e-9]) {
      let first = true;
      const result = generateCombinations(
        { ...input, algorithm: id },
        history,
        () => {
          if (first) {
            first = false;
            return threshold + offset;
          }
          return 0;
        },
      );
      assert.equal(result.games[0].includes(6), offset < 0, id);
    }
  }
});

test("hot, cold, overdue and configurable composite weights change sampling as specified", () => {
  const input = {
    count: 1,
    included: [1, 2, 3, 4, 5],
    excluded: excludeOutside([1, 2, 3, 4, 5, 6, 7]),
  };
  const sample = [draw(10)]; // 6 is a main number; 7 is only the bonus.
  const thresholds: [GenerationAlgorithm, number][] = [
    ["random", 0.5],
    ["hot", 5 / 6],
    ["cold", 1 / 6],
    ["overdue", 1 / 6],
    ["statistical", 5 / 6],
  ];
  for (const [algorithm, threshold] of thresholds) {
    const options = {
      ...input,
      algorithm,
      scoreWeights: { frequency: 100, recent: 0, overdue: 0 },
    };
    assert.equal(
      generateCombinations(options, sample, () => threshold - 1e-9).games[0].at(
        -1,
      ),
      6,
    );
    assert.equal(
      generateCombinations(options, sample, () => threshold + 1e-9).games[0].at(
        -1,
      ),
      7,
    );
    assert.deepEqual(
      keys(
        generateCombinations({ ...options, count: 2 }, sample, () => 0).games,
      ),
      keys([
        [1, 2, 3, 4, 5, 6],
        [1, 2, 3, 4, 5, 7],
      ]),
    );
  }
  const composite = generateCombinations(
    {
      ...input,
      algorithm: "statistical",
      scoreWeights: { frequency: 10, recent: 20, overdue: 30 },
    },
    sample,
  );
  assert.ok(Math.abs(composite.metadata.numberScores[5].score - 0.5) < 1e-12);
});

test("statistics sort and limit collected draws; bonus and missing rounds are not observations", () => {
  const records = Array.from({ length: 11 }, (_, i) => ({
    ...draw(200 - i * 2),
    status: "numbers_only" as const,
    numbers: [1, 2, 3, 4, 5, i === 10 ? 6 : 7],
    bonusNumber: 8,
  })).reverse();
  const full = generationStatistics(records, "all");
  assert.deepEqual(full.analysis, {
    span: "all",
    count: 11,
    fromDraw: 180,
    toDraw: 200,
    missingCount: 10,
    limited: false,
  });
  assert.equal(full.numbers[5].count, 1);
  assert.equal(full.numbers[5].recent, 0.5);
  assert.equal(full.numbers[5].gap, 10);
  assert.equal(full.numbers[7].count, 0);
  assert.equal(full.numbers[7].gap, 11);
  assert.equal(full.numbers[0].frequencyScore, 1);
  assert.equal(full.numbers[7].frequencyScore, 0);
  const latest = generationStatistics(records, "10");
  assert.equal(latest.analysis.count, 10);
  assert.equal(latest.analysis.fromDraw, 182);
  assert.equal(latest.numbers[5].count, 0);
  assert.equal(latest.numbers[5].gap, 10);
  assert.equal(generationStatistics(records, "100").analysis.limited, true);
  const evenCounts = Array.from({ length: 45 }, (_, i) => ({
    ...draw(100 - i),
    numbers: Array.from({ length: 6 }, (_, j) => ((i + j) % 45) + 1),
  }));
  assert.ok(
    generationStatistics(evenCounts, "all").numbers.every(
      (n) => n.frequencyScore === 0.5,
    ),
  );
});

test("balance is an exact optional constraint on every algorithm, including parity extremes", () => {
  for (const { id } of GENERATION_ALGORITHMS) {
    for (const oddCount of [0, 6]) {
      const result = generateCombinations(
        { algorithm: id, count: 3, balance: { ...unrestricted(), oddCount } },
        history,
        seeded(),
      );
      assert.ok(result.details.every((detail) => detail.oddCount === oddCount));
    }
  }
  const fixed = [2, 4, 6, 8, 10, 12];
  const exact: BalanceOptions = {
    oddCount: 0,
    ranges: [
      { min: 5, max: 5 },
      { min: 1, max: 1 },
      ...Array.from({ length: 3 }, () => ({ min: 0, max: 0 })),
    ],
  };
  assert.deepEqual(
    generateCombinations({ count: 1, included: fixed, balance: exact }).games,
    [fixed],
  );
  assert.throws(
    () => generateCombinations({ count: 2, included: fixed, balance: exact }),
    /최대 1게임/,
  );
  assert.throws(
    () =>
      generateCombinations({
        count: 1,
        included: fixed,
        balance: defaultBalance(),
      }),
    /홀짝/,
  );
  assert.throws(
    () =>
      generateCombinations({
        count: 1,
        balance: {
          oddCount: 6,
          ranges: [
            { min: 6, max: 6 },
            ...Array.from({ length: 4 }, () => ({ min: 0, max: 0 })),
          ],
        },
      }),
    /최대 0게임/,
  );
});

test("invalid inputs and unavailable history produce actionable errors without fallback", () => {
  for (const algorithm of ["hot", "cold", "overdue", "statistical"] as const)
    assert.throws(
      () => generateCombinations({ algorithm }),
      /설정에서 데이터를/,
    );
  for (const count of [0, 21, 1.5, NaN])
    assert.throws(() => generateCombinations({ count }), /1~20/);
  for (const included of [[1, 1], [0], [46], [1.2], [1, 2, 3, 4, 5, 6, 7]])
    assert.throws(() => generateCombinations({ included }));
  assert.throws(
    () => generateCombinations({ included: [7], excluded: [7] }),
    /겹칠/,
  );
  assert.throws(
    () => generateCombinations({ excluded: excludeOutside([1, 2, 3, 4, 5]) }),
    /부족/,
  );
  assert.throws(
    () => generateCombinations({ algorithm: "unknown" as GenerationAlgorithm }),
    /알고리즘/,
  );
  assert.throws(
    () => generateCombinations({ balance: { ...unrestricted(), oddCount: 7 } }),
    /홀수/,
  );
  assert.throws(
    () => generateCombinations({ balance: { oddCount: null, ranges: [] } }),
    /5개 구간/,
  );
  assert.throws(
    () =>
      generateCombinations({
        balance: {
          oddCount: null,
          ranges: Array.from({ length: 5 }, () => ({ min: 2, max: 2 })),
        },
      }),
    /총 6개/,
  );
  assert.throws(
    () =>
      generateCombinations(
        {
          algorithm: "statistical",
          scoreWeights: { frequency: 0, recent: 0, overdue: 0 },
        },
        history,
      ),
    /하나 이상/,
  );
  for (const invalid of [-1, 101, NaN, 0.1])
    assert.throws(
      () =>
        generateCombinations(
          {
            algorithm: "statistical",
            scoreWeights: { frequency: invalid, recent: 1, overdue: 1 },
          },
          history,
        ),
      /가중치/,
    );
  for (const invalid of [-1, 1, NaN])
    assert.throws(
      () => generateCombinations({ count: 1 }, [], () => invalid),
      /난수/,
    );
});

test("legacy calls and defaults are preserved; metadata is an immutable input snapshot", () => {
  const original = {
    algorithm: "statistical" as const,
    included: [7],
    balance: defaultBalance(),
    scoreWeights: { frequency: 40, recent: 30, overdue: 30 },
  };
  const copy = structuredClone(original);
  const result = generateCombinations(original, history, seeded());
  assert.deepEqual(original, copy);
  assert.equal(result.games.length, 5);
  assert.equal(result.metadata.options.span, "100");
  original.included.push(8);
  original.balance.ranges[0].max = 6;
  original.scoreWeights.frequency = 0;
  assert.deepEqual(result.metadata.options.included, [7]);
  assert.equal(result.metadata.options.balance!.ranges[0].max, 2);
  assert.equal(result.metadata.options.scoreWeights!.frequency, 40);
  assert.deepEqual(
    generateNumbers(5, [7], [1], seeded()),
    generateCombinations(
      { count: 5, included: [7], excluded: [1] },
      [],
      seeded(),
    ).games,
  );
  assert.equal(generateCombinations().metadata.options.algorithm, "random");
  assert.equal(generateCombinations().metadata.options.balance, null);
});
