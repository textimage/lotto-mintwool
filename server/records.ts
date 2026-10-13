import { createHash } from "node:crypto";
import { z } from "zod";
import { Store } from "./db.js";
import {
  drawDateFor,
  evaluateGame,
  parseLottoQr,
  validateNumbers,
  type PurchaseTicket,
  type TicketView,
} from "../shared/domain.js";

export const numbersSchema = z
  .array(z.number().int().min(1).max(45))
  .length(6)
  .transform(validateNumbers);
export const gameSchema = z.object({
  numbers: numbersSchema,
  quantity: z.number().int().min(1).max(1000).default(1),
});
export const ticketSchema = z.object({
  drawNo: z.number().int().min(1).max(10000),
  drawDate: z.string(),
  memo: z.string().max(2000).default(""),
  games: z.array(gameSchema).min(1).max(100),
  source: z.enum(["manual", "favorite", "qr"]).default("manual"),
  favoriteId: z.string().uuid().nullable().optional(),
  qrRaw: z.string().max(2048).optional(),
});

export function qrPurchaseInput(store: Store, raw: string) {
  const qr = parseLottoQr(raw);
  return {
    drawNo: qr.drawNo,
    drawDate: store.draw(qr.drawNo)?.drawDate ?? drawDateFor(qr.drawNo),
    games: qr.games,
    qrFingerprint: createHash("sha256").update(qr.payload).digest("hex"),
  };
}

export function purchaseInput(
  store: Store,
  raw: unknown,
  userId: string,
  originalFavoriteId?: string | null,
): Omit<PurchaseTicket, "id" | "createdAt" | "updatedAt"> {
  const input = ticketSchema.parse(raw);
  let games = input.games;
  let qrFingerprint: string | null = null;
  if (input.source === "qr") {
    if (!input.qrRaw) throw new Error("QR 원본 내용이 필요합니다.");
    const qr = qrPurchaseInput(store, input.qrRaw);
    games = qr.games;
    qrFingerprint = qr.qrFingerprint;
    if (qr.drawNo !== input.drawNo)
      throw new Error("QR 회차와 입력 회차가 다릅니다.");
  }
  const drawDate =
    store.draw(input.drawNo)?.drawDate ?? drawDateFor(input.drawNo);
  if (input.drawDate !== drawDate)
    throw new Error(`제${input.drawNo}회 추첨일은 ${drawDate}입니다.`);
  if (
    input.favoriteId &&
    input.favoriteId !== originalFavoriteId &&
    !store.favorite(input.favoriteId, userId)
  )
    throw new Error("원본 고정 조합을 찾지 못했습니다.");
  return {
    drawNo: input.drawNo,
    drawDate,
    memo: input.memo,
    games,
    source: input.source,
    favoriteId: input.favoriteId ?? null,
    qrFingerprint,
  };
}

export function ticketView(
  store: Store,
  ticket: PurchaseTicket,
  now = new Date(),
): TicketView {
  const draw = store.draw(ticket.drawNo);
  const results = ticket.games.map((g) =>
    evaluateGame(g.numbers, draw, ticket.drawNo, g.quantity, now),
  );
  return {
    ...ticket,
    results,
    confirmedPrize: results.reduce((sum, r) => sum + (r.prizeTotal ?? 0), 0),
    unsettledGames: results.reduce(
      (sum, r, i) =>
        sum + (r.prizeTotal === null ? ticket.games[i].quantity : 0),
      0,
    ),
  };
}

export interface HistoryQuery {
  numbers: number[];
  from?: number;
  to?: number;
  dateFrom?: string;
  dateTo?: string;
  rank?: number;
  page?: number;
}
export function history(store: Store, input: HistoryQuery) {
  const numbers = validateNumbers(input.numbers);
  if (
    (input.from && input.to && input.from > input.to) ||
    (input.dateFrom && input.dateTo && input.dateFrom > input.dateTo)
  )
    throw new Error("조회 시작 범위가 종료 범위보다 클 수 없습니다.");
  const draws = store
    .draws()
    .filter(
      (d) =>
        (!input.from || d.drawNo >= input.from) &&
        (!input.to || d.drawNo <= input.to) &&
        (!input.dateFrom || d.drawDate >= input.dateFrom) &&
        (!input.dateTo || d.drawDate <= input.dateTo),
    );
  const hits = draws
    .map((draw) => ({ draw, result: evaluateGame(numbers, draw, draw.drawNo) }))
    .filter((r) => r.result.rank !== null);
  const rows = hits.filter((r) => !input.rank || r.result.rank === input.rank);
  const page = input.page ?? 1;
  const pageSize = 25;
  return {
    label: "과거 대조 결과",
    numbers,
    compared: draws.length,
    hits: hits.length,
    bestRank: hits.length ? Math.min(...hits.map((r) => r.result.rank!)) : null,
    counts: [1, 2, 3, 4, 5].map((rank) => ({
      rank,
      count: hits.filter((r) => r.result.rank === rank).length,
    })),
    rows: rows.slice((page - 1) * pageSize, page * pageSize),
    total: rows.length,
    page,
    pageSize,
  };
}
