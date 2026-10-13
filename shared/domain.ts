import { generateCombinations } from "./generator.js";

export const TIMEZONE = "Asia/Seoul";
export const FIRST_DRAW_DATE = "2002-12-07";
const FIRST_DAY = Date.parse(FIRST_DRAW_DATE + "T00:00:00Z");
const WEEK = 7 * 24 * 60 * 60 * 1000;

export type Rank = 1 | 2 | 3 | 4 | 5;
export interface RankPrize {
  rank: Rank;
  totalPrizeAmount: number | null;
  numWinners: number | null;
  prizePerGame: number | null;
}
export interface Draw {
  drawNo: number;
  drawDate: string;
  numbers: number[];
  bonusNumber: number;
  ranks: RankPrize[];
  status: "complete" | "numbers_only";
  source: "github" | "official";
  sourceCommit: string | null;
  updatedAt: string;
}
export interface Favorite {
  id: string;
  name: string;
  numbers: number[];
  memo: string;
  createdAt: string;
  updatedAt: string;
}
export interface EnsureFavoriteResponse {
  favorite: Favorite;
  created: boolean;
}
export interface PurchaseGame {
  id?: string;
  numbers: number[];
  quantity: number;
}
export interface PurchaseTicket {
  id: string;
  drawNo: number;
  drawDate: string;
  memo: string;
  source: "manual" | "favorite" | "qr";
  favoriteId: string | null;
  qrFingerprint: string | null;
  createdAt: string;
  updatedAt: string;
  games: PurchaseGame[];
}
export type ResultStatus =
  "pending" | "missing" | "tallying" | "won" | "lost" | "unpriced";
export interface GameResult {
  status: ResultStatus;
  label: string;
  rank: Rank | null;
  matchedNumbers: number[];
  bonusMatched: boolean;
  prizePerGame: number | null;
  prizeTotal: number | null;
}
export interface TicketView extends PurchaseTicket {
  results: GameResult[];
  confirmedPrize: number;
  unsettledGames: number;
}
export interface PurchaseRoundGroup {
  drawNo: number;
  drawDate: string;
  totalGames: number;
  tickets: TicketView[];
}
export interface GroupedPurchases {
  groups: PurchaseRoundGroup[];
  total: number;
  totalGames: number;
  latestRounds: number[];
  page: number;
  pageSize: number;
}

export function favoriteLabel(
  favorite: Pick<Favorite, "name" | "numbers">,
): string {
  return favorite.name || favorite.numbers.join(", ");
}

export function lottoTaxRule(drawDate: string) {
  return {
    exemptLimit: drawDate < "2023-01-01" ? 50_000 : 2_000_000,
    higherRateThreshold:
      drawDate < "2004-01-01"
        ? null
        : drawDate < "2007-01-01"
          ? 500_000_000
          : 300_000_000,
  };
}

// Estimate from published gross payout and the rules at draw time. Ticket
// expenses, the actual payment date and the paying bank's truncation are excluded.
export function estimateAfterTaxPrize(
  prize: number | null,
  drawDate: string,
): number | null {
  if (prize === null) return null;
  const { exemptLimit, higherRateThreshold } = lottoTaxRule(drawDate);
  if (prize <= exemptLimit) return prize;
  const base =
    higherRateThreshold === null ? prize : Math.min(prize, higherRateThreshold);
  const tax = Math.floor((base * 22 + (prize - base) * 33) / 100);
  return prize - tax;
}
export interface Settings {
  autoSync: boolean;
}
export interface SyncJob {
  id: string;
  mode: "initial" | "latest" | "missing" | "range";
  status: "queued" | "running" | "completed" | "partial" | "failed";
  total: number;
  processed: number;
  saved: number;
  fallbackCount: number;
  errors: string[];
  createdAt: string;
  finishedAt: string | null;
}

export function validateNumbers(value: unknown): number[] {
  if (
    !Array.isArray(value) ||
    value.length !== 6 ||
    !value.every(
      (n) => typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= 45,
    )
  ) {
    throw new Error("1~45 사이의 숫자 6개를 입력해 주세요.");
  }
  if (new Set(value).size !== 6)
    throw new Error("한 게임 안에 같은 번호를 두 번 넣을 수 없습니다.");
  return [...value].sort((a, b) => a - b);
}

export function numberCombinationKey(numbers: number[]): string {
  return validateNumbers(numbers).join(",");
}

export function parseNumbers(input: string): number[] {
  const clean = input.trim().replace(/^[A-E][.:)\s]+/i, "");
  const parts = clean.split(/[\s,;]+/);
  if (!parts.every((part) => /^\d{1,2}$/.test(part)))
    throw new Error("번호는 공백 또는 쉼표로 구분해 주세요.");
  return validateNumbers(parts.map(Number));
}

export interface PastedPurchase {
  games: number[][];
  drawNo?: number;
  drawDate?: string;
}

// Unlabelled number rows keep the normal textarea paste behavior. Recognized
// receipts must be completely valid before any form values are replaced.
export function parsePurchasePaste(input: string): PastedPurchase | null {
  const lines = input
    .normalize("NFKC")
    .replace(/\r\n?/g, "\n")
    .replace(
      /\*\*(\d{1,2})\*\*|__(\d{1,2})__/g,
      (_, stars, underscores) => stars ?? underscores,
    )
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const labelPattern = /^([A-Z])(?:[.:)]|\s+|$)\s*(.*)$/i;
  const roundPattern = /^(?:제\s*)?(\d+)\s*회\s*$/;
  const firstGame = lines.findIndex((line) => labelPattern.test(line));
  if (
    firstGame === -1 &&
    !lines.some((line) => roundPattern.test(line) || /^추첨일/.test(line))
  )
    return null;
  if (firstGame === -1)
    throw new Error("붙여넣은 내용에서 A~E 게임 번호를 찾지 못했습니다.");

  let drawNo: number | undefined;
  let drawDate: string | undefined;
  const header = lines.slice(0, firstGame);
  for (let i = 0; i < header.length; i++) {
    const round = roundPattern.exec(header[i]);
    if (round) {
      if (drawNo !== undefined)
        throw new Error("한 번에 복권 한 장의 내용만 붙여넣어 주세요.");
      drawNo = Number(round[1]);
      drawDateFor(drawNo);
    }
    const dateField = /^추첨일\s*:?\s*(.*)$/.exec(header[i]);
    if (dateField) {
      if (drawDate !== undefined)
        throw new Error("한 번에 복권 한 장의 내용만 붙여넣어 주세요.");
      const value = dateField[1] || header[++i] || "";
      const date = /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})(?:\s*\([^)]+\))?$/.exec(
        value,
      );
      if (!date) throw new Error("붙여넣은 추첨일의 형식을 확인해 주세요.");
      drawDate = `${date[1]}-${date[2].padStart(2, "0")}-${date[3].padStart(2, "0")}`;
      roundForDate(drawDate);
    }
  }
  if (drawNo !== undefined) {
    const expectedDate = drawDateFor(drawNo);
    if (drawDate !== undefined && drawDate !== expectedDate)
      throw new Error("붙여넣은 회차와 추첨일이 일치하지 않습니다.");
    drawDate = expectedDate;
  } else if (drawDate !== undefined) {
    drawNo = roundForDate(drawDate);
  }

  const games: number[][] = [];
  const labels = new Set<string>();
  let current: { label: string; lines: string[] } | undefined;
  let footer = false;
  function finishGame() {
    if (!current) return;
    try {
      games.push(parseNumbers(current.lines.join(" ")));
    } catch (error) {
      throw new Error(`${current.label} 게임: ${(error as Error).message}`);
    }
    current = undefined;
  }
  for (const line of lines.slice(firstGame)) {
    const label = labelPattern.exec(line);
    if (label) {
      finishGame();
      const name = label[1].toUpperCase();
      if (footer || !/^[A-E]$/.test(name) || labels.has(name))
        throw new Error(
          "한 번에 A~E 게임이 있는 복권 한 장만 붙여넣어 주세요.",
        );
      labels.add(name);
      const numbers = label[2].replace(/^(?:수동|자동|반자동)(?:\s+|$)/, "");
      current = { label: name, lines: numbers ? [numbers] : [] };
      continue;
    }
    // The printed total and repeated verification number follow the last game.
    if (
      /^(?:합계|총액|금액)(?:\s|:|$)/.test(line) ||
      /^(?:₩\s*\d[\d,]*(?:\s*원)?|\d[\d,]*\s*원)$/.test(line) ||
      /^(?:\d{5}(?:\s+\d{5}){0,5}|\d{30})$/.test(line)
    ) {
      finishGame();
      footer = true;
      continue;
    }
    if (footer) continue;
    if (current && !current.lines.length) {
      const numbers = line.replace(/^(?:수동|자동|반자동)(?:\s+|$)/, "");
      if (numbers !== line) {
        if (numbers) current.lines.push(numbers);
        continue;
      }
    }
    current?.lines.push(line);
  }
  finishGame();
  return {
    games,
    ...(drawNo === undefined ? {} : { drawNo, drawDate }),
  };
}

export function drawDateFor(drawNo: number): string {
  if (!Number.isInteger(drawNo) || drawNo < 1 || drawNo > 10000)
    throw new Error("회차는 1~10000 사이의 정수여야 합니다.");
  return new Date(FIRST_DAY + (drawNo - 1) * WEEK).toISOString().slice(0, 10);
}
export function roundForDate(date: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date))
    throw new Error("추첨일을 YYYY-MM-DD 형식으로 입력해 주세요.");
  const day = Date.parse(date + "T00:00:00Z");
  const round = (day - FIRST_DAY) / WEEK + 1;
  if (!Number.isInteger(round) || drawDateFor(round) !== date)
    throw new Error("추첨일은 2002년 12월 7일 이후의 토요일이어야 합니다.");
  return round;
}
export function publishedCandidate(now = new Date()): number {
  // A calendar candidate is not considered published until a valid source confirms it.
  const firstBroadcast = FIRST_DAY + (20 * 60 + 45 - 9 * 60) * 60 * 1000;
  return Math.max(0, Math.floor((now.getTime() - firstBroadcast) / WEEK) + 1);
}
export function nextPurchaseRound(now = new Date()): number {
  const firstClosing = FIRST_DAY + (20 - 9) * 60 * 60 * 1000;
  return Math.max(1, Math.floor((now.getTime() - firstClosing) / WEEK) + 2);
}
export function koreanDate(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

export function evaluateGame(
  numbers: number[],
  draw: Draw | undefined,
  drawNo: number,
  quantity = 1,
  now = new Date(),
): GameResult {
  const chosen = validateNumbers(numbers);
  const empty = {
    rank: null,
    matchedNumbers: [],
    bonusMatched: false,
    prizePerGame: null,
    prizeTotal: null,
  };
  if (!draw) {
    const pending =
      now.getTime() < Date.parse(drawDateFor(drawNo) + "T20:45:00+09:00");
    return {
      ...empty,
      status: pending ? "pending" : "missing",
      label: pending ? "추첨 대기" : "결과 미수집",
    };
  }
  const matchedNumbers = chosen.filter((n) => draw.numbers.includes(n));
  const bonusMatched = chosen.includes(draw.bonusNumber);
  const count = matchedNumbers.length;
  const rank: Rank | null =
    count === 6
      ? 1
      : count === 5
        ? bonusMatched
          ? 2
          : 3
        : count === 4
          ? 4
          : count === 3
            ? 5
            : null;
  if (!rank)
    return {
      status: "lost",
      label: "낙첨",
      rank: null,
      matchedNumbers,
      bonusMatched,
      prizePerGame: 0,
      prizeTotal: 0,
    };
  const prize = draw.ranks.find((r) => r.rank === rank);
  if (
    draw.status !== "complete" ||
    !prize ||
    prize.prizePerGame === null ||
    prize.numWinners === null
  ) {
    return {
      status: "tallying",
      label: "당첨금 집계 중",
      rank,
      matchedNumbers,
      bonusMatched,
      prizePerGame: null,
      prizeTotal: null,
    };
  }
  if (prize.numWinners === 0 || prize.prizePerGame === 0) {
    return {
      status: "unpriced",
      label: "조건 일치 · 배당 산정 불가",
      rank,
      matchedNumbers,
      bonusMatched,
      prizePerGame: null,
      prizeTotal: null,
    };
  }
  return {
    status: "won",
    label: `${rank}등 당첨`,
    rank,
    matchedNumbers,
    bonusMatched,
    prizePerGame: prize.prizePerGame,
    prizeTotal: prize.prizePerGame * quantity,
  };
}

export function parseLottoQr(input: string): {
  drawNo: number;
  games: PurchaseGame[];
  payload: string;
} {
  const clean = input.trim();
  if (clean.length > 2048) throw new Error("QR 내용이 너무 깁니다.");
  let payload = clean;
  if (/^https?:\/\//i.test(clean)) {
    const url = new URL(clean);
    if (
      !["dhlottery.co.kr", "www.dhlottery.co.kr", "m.dhlottery.co.kr"].includes(
        url.hostname.toLowerCase(),
      ) ||
      !["/qr.do", "/qr"].includes(url.pathname)
    ) {
      throw new Error("동행복권 로또 6/45 QR 주소만 등록할 수 있습니다.");
    }
    if (
      url.username ||
      url.password ||
      (url.port && !["80", "443"].includes(url.port))
    )
      throw new Error("올바른 QR 주소를 입력해 주세요.");
    payload = url.searchParams.get("v") ?? "";
  }
  const start = /^(\d{1,5})(?=[mqs])/i.exec(payload);
  if (!start)
    throw new Error(
      "로또 6/45 QR을 읽지 못했습니다. 번호를 직접 입력할 수 있습니다.",
    );
  const drawNo = Number(start[1]);
  drawDateFor(drawNo);
  const segments = payload
    .slice(start[1].length)
    .replace(/\.net$/i, "")
    .split(/[mqs]/i)
    .slice(1);
  if (segments.length < 1 || segments.length > 5)
    throw new Error("QR에는 1~5개의 게임이 있어야 합니다.");
  const games = segments.map((segment, index) => {
    const valid =
      index === segments.length - 1
        ? /^\d{12}(?:\d{0,24})$/.test(segment)
        : /^\d{12}$/.test(segment);
    if (!valid) throw new Error("QR 게임 번호의 형식이 올바르지 않습니다.");
    return {
      numbers: validateNumbers(
        segment.slice(0, 12).match(/\d{2}/g)!.map(Number),
      ),
      quantity: 1,
    };
  });
  return {
    drawNo,
    games,
    payload:
      String(drawNo) +
      payload
        .slice(start[1].length)
        .replace(/\.net$/i, "")
        .toLowerCase(),
  };
}

export function generateNumbers(
  count: number,
  included: number[] = [],
  excluded: number[] = [],
  random: () => number = Math.random,
): number[][] {
  return generateCombinations({ count, included, excluded }, [], random).games;
}
