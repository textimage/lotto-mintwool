import type { Draw } from "./domain.js";

export const GENERATION_ALGORITHM_IDS = [
  "random",
  "hot",
  "cold",
  "overdue",
  "balanced",
  "statistical",
] as const;
export type GenerationAlgorithm = (typeof GENERATION_ALGORITHM_IDS)[number];
export const GENERATION_SPANS = ["10", "50", "100", "all"] as const;
export type GenerationSpan = (typeof GENERATION_SPANS)[number];
export const GENERATION_RANGES = ["1~10", "11~20", "21~30", "31~40", "41~45"];
export const GENERATION_ALGORITHMS: {
  id: GenerationAlgorithm;
  name: string;
  description: string;
  requiresHistory: boolean;
}[] = [
  {
    id: "random",
    name: "무작위",
    description: "조건을 만족하는 모든 조합을 같은 비중으로 선택합니다.",
    requiresHistory: false,
  },
  {
    id: "hot",
    name: "자주 나온 번호 우대",
    description: "분석 범위에서 자주 등장한 번호에 더 큰 비중을 둡니다.",
    requiresHistory: true,
  },
  {
    id: "cold",
    name: "적게 나온 번호 우대",
    description: "분석 범위에서 적게 등장한 번호에 더 큰 비중을 둡니다.",
    requiresHistory: true,
  },
  {
    id: "overdue",
    name: "오래 안 나온 번호 우대",
    description: "최근 수집 회차에서 연속으로 등장하지 않은 번호를 우대합니다.",
    requiresHistory: true,
  },
  {
    id: "balanced",
    name: "홀짝·구간 균형",
    description: "지정한 홀짝 비율과 구간별 개수를 정확히 맞춥니다.",
    requiresHistory: false,
  },
  {
    id: "statistical",
    name: "통계 점수형",
    description:
      "출현 빈도·최근 출현·미출현 기간을 원하는 비중으로 종합합니다.",
    requiresHistory: true,
  },
];
export interface BalanceOptions {
  oddCount: number | null;
  ranges: { min: number; max: number }[];
}
export interface ScoreWeights {
  frequency: number;
  recent: number;
  overdue: number;
}
export const DEFAULT_SCORE_WEIGHTS: ScoreWeights = {
  frequency: 40,
  recent: 30,
  overdue: 30,
};
export function defaultBalance(): BalanceOptions {
  return {
    oddCount: 3,
    ranges: GENERATION_RANGES.map(() => ({ min: 0, max: 2 })),
  };
}
export interface GenerationOptions {
  algorithm?: GenerationAlgorithm;
  count?: number;
  included?: number[];
  excluded?: number[];
  span?: GenerationSpan;
  balance?: BalanceOptions;
  scoreWeights?: ScoreWeights;
}
export interface AppliedGenerationOptions {
  algorithm: GenerationAlgorithm;
  count: number;
  included: number[];
  excluded: number[];
  span: GenerationSpan | null;
  balance: BalanceOptions | null;
  scoreWeights: ScoreWeights | null;
}
export interface GenerationAnalysis {
  span: GenerationSpan;
  count: number;
  fromDraw: number;
  toDraw: number;
  missingCount: number;
  limited: boolean;
}
export interface NumberStatistics {
  number: number;
  count: number;
  recent: number;
  gap: number;
  frequencyScore: number;
  recentScore: number;
  gapScore: number;
}
export interface NumberGenerationScore extends NumberStatistics {
  score: number;
  weight: number;
}
export interface GenerationResult {
  games: number[][];
  details: { oddCount: number; rangeCounts: number[] }[];
  metadata: {
    options: AppliedGenerationOptions;
    analysis: GenerationAnalysis | null;
    numberScores: NumberGenerationScore[];
    possibleCombinations: number;
  };
}

export function generationAlgorithm(id: GenerationAlgorithm) {
  const algorithm = GENERATION_ALGORITHMS.find((entry) => entry.id === id);
  if (!algorithm) throw new Error("지원하지 않는 생성 알고리즘입니다.");
  return algorithm;
}

function normalize(values: number[]): number[] {
  const min = Math.min(...values),
    max = Math.max(...values);
  return values.map((value) =>
    max === min ? 0.5 : (value - min) / (max - min),
  );
}

export function generationStatistics(draws: Draw[], span: GenerationSpan) {
  if (!GENERATION_SPANS.includes(span))
    throw new Error("분석 범위를 확인해 주세요.");
  const sorted = [...draws].sort((a, b) => b.drawNo - a.drawNo);
  const selected = span === "all" ? sorted : sorted.slice(0, Number(span));
  if (!selected.length)
    throw new Error(
      "통계 기반 생성에 필요한 회차가 없습니다. 설정에서 데이터를 가져와 주세요.",
    );
  const numbers = Array.from({ length: 45 }, (_, i) => ({
    number: i + 1,
    count: 0,
    recent: 0,
    gap: selected.length,
  }));
  selected.forEach((draw, index) => {
    for (const number of draw.numbers) {
      const entry = numbers[number - 1];
      entry.count++;
      entry.recent += 2 ** (-index / 10);
      entry.gap = Math.min(entry.gap, index);
    }
  });
  const frequency = normalize(numbers.map((n) => n.count));
  const recent = normalize(numbers.map((n) => n.recent));
  const gap = normalize(numbers.map((n) => n.gap));
  const analysis: GenerationAnalysis = {
    span,
    count: selected.length,
    fromDraw: selected.at(-1)!.drawNo,
    toDraw: selected[0].drawNo,
    missingCount:
      selected[0].drawNo - selected.at(-1)!.drawNo + 1 - selected.length,
    limited: span !== "all" && selected.length < Number(span),
  };
  return {
    analysis,
    numbers: numbers.map((entry, i): NumberStatistics => ({
      ...entry,
      frequencyScore: frequency[i],
      recentScore: recent[i],
      gapScore: gap[i],
    })),
  };
}

function resolveOptions(input: GenerationOptions): AppliedGenerationOptions {
  const algorithm = input.algorithm ?? "random";
  const definition = generationAlgorithm(algorithm);
  const count = input.count ?? 5;
  if (!Number.isInteger(count) || count < 1 || count > 20)
    throw new Error("1~20게임을 생성할 수 있습니다.");
  const included = [...(input.included ?? [])].sort((a, b) => a - b);
  const excluded = [...(input.excluded ?? [])].sort((a, b) => a - b);
  for (const numbers of [included, excluded]) {
    if (
      !numbers.every((n) => Number.isInteger(n) && n >= 1 && n <= 45) ||
      new Set(numbers).size !== numbers.length
    )
      throw new Error("포함·제외 번호는 중복 없는 1~45의 숫자여야 합니다.");
  }
  if (included.length > 6 || included.some((n) => excluded.includes(n)))
    throw new Error("포함 번호는 최대 6개이며 제외 번호와 겹칠 수 없습니다.");
  if (45 - excluded.length < 6)
    throw new Error("선택할 수 있는 번호가 부족합니다.");
  const span = input.span ?? "100";
  if (!GENERATION_SPANS.includes(span))
    throw new Error("분석 범위를 확인해 주세요.");
  const requestedBalance =
    input.balance ?? (algorithm === "balanced" ? defaultBalance() : null);
  const balance = requestedBalance
    ? {
        oddCount: requestedBalance.oddCount,
        ranges: requestedBalance.ranges.map((range) => ({ ...range })),
      }
    : null;
  if (balance) {
    if (
      balance.oddCount !== null &&
      (!Number.isInteger(balance.oddCount) ||
        balance.oddCount < 0 ||
        balance.oddCount > 6)
    )
      throw new Error("홀수 개수는 0~6개 또는 제한 없음이어야 합니다.");
    if (
      balance.ranges.length !== 5 ||
      balance.ranges.some(
        ({ min, max }) =>
          !Number.isInteger(min) ||
          !Number.isInteger(max) ||
          min < 0 ||
          max > 6 ||
          min > max,
      )
    )
      throw new Error(
        "5개 구간의 최소·최대 개수를 0~6 사이로 지정하고, 최소가 최대보다 크지 않게 해 주세요.",
      );
    if (
      balance.ranges.reduce((sum, r) => sum + r.min, 0) > 6 ||
      balance.ranges.reduce((sum, r) => sum + r.max, 0) < 6
    )
      throw new Error(
        "구간별 최소·최대 개수로 총 6개 번호를 구성할 수 없습니다.",
      );
    const fixedOdd = included.filter((n) => n % 2).length;
    if (
      balance.oddCount !== null &&
      (fixedOdd > balance.oddCount ||
        included.length - fixedOdd > 6 - balance.oddCount)
    )
      throw new Error(
        "포함 번호가 지정한 홀짝 개수와 충돌합니다. 포함 번호 또는 홀수 개수를 수정해 주세요.",
      );
    balance.ranges.forEach((range, i) => {
      if (
        included.filter((n) => Math.floor((n - 1) / 10) === i).length >
        range.max
      )
        throw new Error(
          `${GENERATION_RANGES[i]} 구간의 포함 번호가 최대 개수를 넘습니다.`,
        );
    });
  }
  const scoreWeights =
    algorithm === "statistical"
      ? { ...(input.scoreWeights ?? DEFAULT_SCORE_WEIGHTS) }
      : null;
  if (scoreWeights) {
    const weights = [
      scoreWeights.frequency,
      scoreWeights.recent,
      scoreWeights.overdue,
    ];
    if (
      weights.some((w) => !Number.isInteger(w) || w < 0 || w > 100) ||
      weights.every((w) => w === 0)
    )
      throw new Error(
        "통계 가중치는 각각 0~100이며, 하나 이상은 0보다 커야 합니다.",
      );
  }
  return {
    algorithm,
    count,
    included,
    excluded,
    span: definition.requiresHistory ? span : null,
    balance,
    scoreWeights,
  };
}

// A suffix state remembers only the current range. Completed ranges are checked
// at their boundary, so the DP stays small even for all 8,145,060 combinations.
type State = {
  number: number;
  left: number;
  oddLeft: number;
  rangeUsed: number;
};
type Mass = { count: number; weight: number };
type Removed = Mass & { take?: Removed; skip?: Removed };
const emptyMass = (): Mass => ({ count: 0, weight: 0 });

export function generateCombinations(
  input: GenerationOptions = {},
  draws: Draw[] = [],
  random: () => number = Math.random,
): GenerationResult {
  const options = resolveOptions(input);
  const statistics = options.span
    ? generationStatistics(draws, options.span)
    : null;
  const numberScores: NumberGenerationScore[] =
    statistics?.numbers.map((entry) => {
      let score: number;
      switch (options.algorithm) {
        case "hot":
          score = entry.frequencyScore;
          break;
        case "cold":
          score = 1 - entry.frequencyScore;
          break;
        case "overdue":
          score = entry.gapScore;
          break;
        case "statistical": {
          const { frequency, recent, overdue } = options.scoreWeights!;
          score =
            (frequency * entry.frequencyScore +
              recent * entry.recentScore +
              overdue * entry.gapScore) /
            (frequency + recent + overdue);
          break;
        }
        default:
          score = 0;
      }
      return { ...entry, score, weight: 1 + 4 * score };
    }) ?? [];
  const weights = Array.from(
    { length: 45 },
    (_, i) => numberScores[i]?.weight ?? 1,
  );
  const included = new Set(options.included),
    excluded = new Set(options.excluded);
  const limits =
    options.balance?.ranges ??
    GENERATION_RANGES.map(() => ({ min: 0, max: 6 }));
  const start: State = {
    number: 1,
    left: 6,
    oddLeft: options.balance?.oddCount ?? -1,
    rangeUsed: 0,
  };
  const memo = new Map<string, Mass>();
  function advance(state: State, take: boolean): State | null {
    const { number, left, oddLeft, rangeUsed } = state;
    if (take ? excluded.has(number) || left === 0 : included.has(number))
      return null;
    const range = Math.floor((number - 1) / 10);
    const used = rangeUsed + Number(take);
    const remainingOdd = oddLeft < 0 ? -1 : oddLeft - (take ? number % 2 : 0);
    if (oddLeft >= 0 && remainingOdd < 0) return null;
    if (used > limits[range].max) return null;
    const boundary = number % 10 === 0 || number === 45;
    if (boundary && used < limits[range].min) return null;
    return {
      number: number + 1,
      left: left - Number(take),
      oddLeft: remainingOdd,
      rangeUsed: boundary ? 0 : used,
    };
  }
  function solve(state: State | null): Mass {
    if (
      !state ||
      state.left < 0 ||
      state.left > 46 - state.number ||
      state.oddLeft > state.left
    )
      return emptyMass();
    if (state.number === 46)
      return state.left === 0 && state.oddLeft <= 0
        ? { count: 1, weight: 1 }
        : emptyMass();
    const key = `${state.number},${state.left},${state.oddLeft},${state.rangeUsed}`;
    const cached = memo.get(key);
    if (cached) return cached;
    const take = solve(advance(state, true)),
      skip = solve(advance(state, false));
    const result = {
      count: take.count + skip.count,
      weight: weights[state.number - 1] * take.weight + skip.weight,
    };
    memo.set(key, result);
    return result;
  }
  const possibleCombinations = solve(start).count;
  if (possibleCombinations < options.count)
    throw new Error(
      `조건에 맞는 조합은 최대 ${possibleCombinations.toLocaleString("ko-KR")}게임입니다. 게임 수를 줄이거나 포함·제외 번호와 균형 조건을 수정해 주세요.`,
    );

  // Remove complete paths, not DP states: distinct prefixes can share a suffix
  // state. Each trie node stores removed mass in that suffix's own weight units.
  const removed: Removed = emptyMass();
  const games: number[][] = [];
  for (let game = 0; game < options.count; game++) {
    let state = start,
      node = removed;
    const numbers: number[] = [];
    const path: { node: Removed; factor: number }[] = [];
    while (state.number <= 45) {
      const takeState = advance(state, true),
        skipState = advance(state, false);
      const take = solve(takeState),
        skip = solve(skipState);
      const takeCount = take.count - (node.take?.count ?? 0);
      const skipCount = skip.count - (node.skip?.count ?? 0);
      const takeMass = takeCount
        ? weights[state.number - 1] * (take.weight - (node.take?.weight ?? 0))
        : 0;
      const skipMass = skipCount ? skip.weight - (node.skip?.weight ?? 0) : 0;
      let selected = skipCount === 0;
      if (takeCount && skipCount) {
        const value = random();
        if (!Number.isFinite(value) || value < 0 || value >= 1)
          throw new Error("난수는 0 이상 1 미만이어야 합니다.");
        selected = value * (takeMass + skipMass) < takeMass;
      }
      const factor = selected ? weights[state.number - 1] : 1;
      if (selected) numbers.push(state.number);
      path.push({ node, factor });
      const branch = selected ? "take" : "skip";
      node = node[branch] ??= emptyMass();
      state = (selected ? takeState : skipState)!;
    }
    node.count++;
    node.weight++;
    let weight = 1;
    for (let i = path.length - 1; i >= 0; i--) {
      weight *= path[i].factor;
      path[i].node.count++;
      path[i].node.weight += weight;
    }
    games.push(numbers);
  }
  return {
    games,
    details: games.map((numbers) => ({
      oddCount: numbers.filter((n) => n % 2).length,
      rangeCounts: GENERATION_RANGES.map(
        (_, i) => numbers.filter((n) => Math.floor((n - 1) / 10) === i).length,
      ),
    })),
    metadata: {
      options,
      analysis: statistics?.analysis ?? null,
      numberScores,
      possibleCombinations,
    },
  };
}
