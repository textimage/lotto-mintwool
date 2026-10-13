import { drawDateFor, type Draw, type Rank } from "../shared/domain.js";
export function draw(no = 1245, source: Draw["source"] = "official"): Draw {
  return {
    drawNo: no,
    drawDate: drawDateFor(no),
    numbers: [1, 2, 3, 4, 5, 6],
    bonusNumber: 7,
    status: "complete",
    source,
    sourceCommit: source === "github" ? "a".repeat(40) : null,
    updatedAt: "2026-10-12T00:00:00Z",
    ranks: ([1, 2, 3, 4, 5] as Rank[]).map((rank, index) => ({
      rank,
      numWinners: 10,
      prizePerGame: [3000000000, 50000000, 1500000, 50000, 5000][index],
      totalPrizeAmount:
        [3000000000, 50000000, 1500000, 50000, 5000][index] * 10,
    })),
  };
}
export function rawDraw(
  data = draw(),
  source: Draw["source"] = "official",
): Record<string, unknown> {
  if (source === "github")
    return {
      draw_no: data.drawNo,
      draw_date: data.drawDate,
      winning_numbers: data.numbers,
      bonus_number: data.bonusNumber,
      rank_details: data.ranks.map((r) => ({
        rank: r.rank,
        num_winners: r.numWinners,
        prize_per_game: r.prizePerGame,
        total_prize_amount: r.totalPrizeAmount,
      })),
    };
  const raw: Record<string, unknown> = {
    ltEpsd: data.drawNo,
    ltRflYmd: data.drawDate.replaceAll("-", ""),
    bnsWnNo: data.bonusNumber,
  };
  data.numbers.forEach((n, i) => (raw[`tm${i + 1}WnNo`] = n));
  for (const r of data.ranks) {
    raw[`rnk${r.rank}WnNope`] = r.numWinners;
    raw[`rnk${r.rank}WnAmt`] = r.prizePerGame;
    raw[`rnk${r.rank}SumWnAmt`] = r.totalPrizeAmount;
  }
  return raw;
}
export const qrSample =
  "https://m.dhlottery.co.kr/qr.do?method=winQr&v=1171m061921354045m112124303945m051317183342m021417303845m0507111217240000000645.net";
