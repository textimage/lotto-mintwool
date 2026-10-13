import {
  drawDateFor,
  koreanDate,
  roundForDate,
  parseNumbers,
} from "../shared/domain.js";
import { Store } from "./db.js";
import { history, ticketView } from "./records.js";

export const HELP = [
  "로또 기록장 봇입니다.",
  "번호 6개를 공백 또는 쉼표로 보내면 과거 당첨 이력을 요약합니다.",
  "예: 1 7 13 22 35 44",
  "로또 용지 사진을 보내면 QR을 읽어 구매내역에 즉시 등록합니다. 사진 한 장에 복권 한 장을 담아 주세요.",
  "토요일 21시에는 그날 회차의 구매 결과를 보내고, 집계 중이면 확정 후 추가로 알려드립니다.",
  "/help — 사용법",
].join("\n");
const money = (amount: number) => amount.toLocaleString("ko-KR") + "원";

export function historyMessage(store: Store, text: string): string {
  const data = history(store, { numbers: parseNumbers(text) });
  const lines = [
    "과거 당첨 대조",
    `번호: ${data.numbers.join(" ")}`,
    `대조한 회차: ${data.compared}회`,
  ];
  if (!data.compared) lines.push("아직 수집된 당첨 기록이 없습니다.");
  else if (data.bestRank === null) lines.push("당첨 기록이 없습니다.");
  else {
    lines.push(
      `최고 당첨 순위: ${data.bestRank}등`,
      data.counts.map((r) => `${r.rank}등 ${r.count}회`).join(" · "),
      "최고 등수의 최근 회차:",
    );
    for (const row of history(store, {
      numbers: data.numbers,
      rank: data.bestRank,
    }).rows.slice(0, 3))
      lines.push(
        `${row.draw.drawNo}회 (${row.draw.drawDate}) · ${row.result.rank}등`,
      );
  }
  lines.push("과거 대조 결과이며 실제 구매 당첨 기록에 합산되지 않습니다.");
  return lines.join("\n");
}

export function roundReport(
  store: Store,
  userId: string,
  drawNo: number,
  origin: string,
  now: Date,
  final = false,
): string {
  const draw = store.draw(drawNo);
  const tickets = store
    .tickets(userId)
    .filter((t) => t.drawNo === drawNo)
    .map((t) => ticketView(store, t, now));
  const total = tickets.reduce(
    (sum, t) => sum + t.games.reduce((n, g) => n + g.quantity, 0),
    0,
  );
  const prize = tickets.reduce((sum, t) => sum + t.confirmedPrize, 0);
  const unsettled = tickets.reduce((sum, t) => sum + t.unsettledGames, 0);
  const winners = tickets.reduce(
    (sum, t) =>
      sum +
      t.results.reduce(
        (n, r, i) => n + (r.rank !== null ? t.games[i].quantity : 0),
        0,
      ),
    0,
  );
  const lines = [
    `제${drawNo}회 (${drawDateFor(drawNo)}) ${final ? "확정 " : ""}구매 결과`,
  ];
  if (!draw)
    lines.push(
      "당첨번호: 결과 미수집 · 확인 후 확정 결과를 추가로 보내드립니다.",
    );
  else {
    lines.push(
      `당첨번호: ${draw.numbers.join(" ")} + 보너스 ${draw.bonusNumber}`,
    );
    if (draw.status !== "complete")
      lines.push("당첨금 집계 중 · 배당 확정 후 결과를 추가로 보내드립니다.");
  }
  lines.push(
    `구매번호수: ${total}개`,
    `당첨번호수: ${draw ? `${winners}개 (등수 판정 기준)` : "확인 대기"}`,
  );
  if (!tickets.length) lines.push("등록된 구매내역 없음");
  else {
    lines.push(
      `확정 세전 당첨금: ${money(prize)}${unsettled ? ` · 미확정 ${unsettled}개 별도` : ""}`,
    );
    tickets.forEach((ticket, ti) =>
      ticket.games.forEach((game, gi) => {
        const r = ticket.results[gi];
        const status = r.rank !== null ? `${r.rank}등 · ${r.label}` : r.label;
        lines.push(
          `복권 ${ti + 1} / 게임 ${gi + 1}: ${game.numbers.join(" ")} ×${game.quantity} → ${status}${r.prizeTotal !== null && r.rank !== null ? ` · ${money(r.prizeTotal)}` : ""}`,
        );
      }),
    );
  }
  lines.push(`${origin}/purchases?drawNo=${drawNo}`);
  return lines.join("\n");
}

// Never split a game row; leave room for the multipart heading.
export function splitMessage(text: string, limit = 3500): string[] {
  const chunks: string[] = [];
  let chunk = "";
  for (const line of text.split("\n")) {
    if (line.length > limit - 30) throw new Error("메시지 행이 너무 깁니다.");
    if (chunk && chunk.length + line.length + 1 > limit - 30) {
      chunks.push(chunk);
      chunk = "";
    }
    chunk += (chunk ? "\n" : "") + line;
  }
  if (chunk) chunks.push(chunk);
  return chunks.length > 1
    ? chunks.map((part, i) => `(${i + 1}/${chunks.length})\n${part}`)
    : chunks;
}

export function latestDueDraw(now: Date): { drawNo: number; dueAt: number } {
  const today = koreanDate(now);
  const day = Date.parse(today + "T00:00:00Z");
  const weekday = new Date(day).getUTCDay();
  let saturday = day - ((weekday + 1) % 7) * 86400000;
  if (weekday === 6 && now.getTime() < Date.parse(today + "T21:00:00+09:00"))
    saturday -= 7 * 86400000;
  const date = new Date(saturday).toISOString().slice(0, 10);
  return {
    drawNo: roundForDate(date),
    dueAt: Date.parse(date + "T21:00:00+09:00"),
  };
}

export function nextRefresh(drawNo: number, now: Date): number {
  const cutoff =
    Date.parse(drawDateFor(drawNo) + "T21:00:00+09:00") + 6 * 3600000;
  if (now.getTime() < cutoff)
    return Math.min(cutoff, (Math.floor(now.getTime() / 900000) + 1) * 900000);
  let next = Date.parse(koreanDate(now) + "T03:00:00+09:00");
  if (next <= now.getTime()) next += 86400000;
  return next;
}
