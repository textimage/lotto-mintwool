import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import * as tar from "tar";
import {
  drawDateFor,
  validateNumbers,
  type Draw,
  type Rank,
  type RankPrize,
} from "../shared/domain.js";

const REPOSITORY = "https://api.github.com/repos/johyunchol/lottogo-python";
const RAW = "https://raw.githubusercontent.com/johyunchol/lottogo-python";
export type FetchLike = typeof fetch;
function numeric(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const number =
    typeof value === "string" && /^\d[\d,]*$/.test(value)
      ? Number(value.replaceAll(",", ""))
      : value;
  if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 0)
    throw new Error("배당 또는 당첨자 집계의 숫자가 올바르지 않습니다.");
  return number;
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("데이터 형식이 올바르지 않습니다.");
  return value as Record<string, unknown>;
}
export function normalizeDraw(
  value: unknown,
  source: Draw["source"],
  expected?: number,
  commit: string | null = null,
): Draw {
  const row = object(value);
  const drawNo = Number(source === "official" ? row.ltEpsd : row.draw_no);
  if (expected !== undefined && drawNo !== expected)
    throw new Error(`요청한 ${expected}회차와 응답 회차가 다릅니다.`);
  const rawDate =
    source === "official"
      ? String(row.ltRflYmd ?? "").replace(
          /^(\d{4})(\d{2})(\d{2})$/,
          "$1-$2-$3",
        )
      : String(row.draw_date ?? "");
  if (rawDate !== drawDateFor(drawNo))
    throw new Error(`${drawNo}회차의 추첨일이 올바르지 않습니다.`);
  const numbers = validateNumbers(
    source === "official"
      ? [
          row.tm1WnNo,
          row.tm2WnNo,
          row.tm3WnNo,
          row.tm4WnNo,
          row.tm5WnNo,
          row.tm6WnNo,
        ]
      : row.winning_numbers,
  );
  const bonusNumber = source === "official" ? row.bnsWnNo : row.bonus_number;
  if (
    typeof bonusNumber !== "number" ||
    !Number.isInteger(bonusNumber) ||
    bonusNumber < 1 ||
    bonusNumber > 45 ||
    numbers.includes(bonusNumber)
  )
    throw new Error("보너스 번호가 올바르지 않습니다.");
  const rawRanks =
    source === "github" && Array.isArray(row.rank_details)
      ? row.rank_details.map(object)
      : [];
  const ranks: RankPrize[] = ([1, 2, 3, 4, 5] as Rank[]).map((rank) => {
    const detail = rawRanks.find((r) => Number(r.rank) === rank);
    return {
      rank,
      totalPrizeAmount: numeric(
        source === "official"
          ? row[`rnk${rank}SumWnAmt`]
          : detail?.total_prize_amount,
      ),
      numWinners: numeric(
        source === "official" ? row[`rnk${rank}WnNope`] : detail?.num_winners,
      ),
      prizePerGame: numeric(
        source === "official" ? row[`rnk${rank}WnAmt`] : detail?.prize_per_game,
      ),
    };
  });
  const complete =
    ranks.every(
      (r) =>
        r.numWinners !== null &&
        r.prizePerGame !== null &&
        r.totalPrizeAmount !== null &&
        (r.numWinners === 0 || (r.prizePerGame > 0 && r.totalPrizeAmount > 0)),
    ) && (ranks[4].numWinners ?? 0) > 0;
  return {
    drawNo,
    drawDate: rawDate,
    numbers,
    bonusNumber,
    ranks,
    status: complete ? "complete" : "numbers_only",
    source,
    sourceCommit: commit,
    updatedAt: new Date().toISOString(),
  };
}

export class Sources {
  constructor(
    readonly request: FetchLike = fetch,
    readonly retries = 2,
  ) {}
  async response(url: string, official = false): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      try {
        const response = await this.request(url, {
          signal: AbortSignal.timeout(10000),
          headers: official
            ? {
                Accept: "application/json",
                AJAX: "true",
                "X-Requested-With": "XMLHttpRequest",
                Referer: "https://www.dhlottery.co.kr/lt645/result",
                "User-Agent": "LottoNote/1.0",
              }
            : { Accept: "application/json", "User-Agent": "LottoNote/1.0" },
        });
        if (!response.ok)
          throw new Error(`원본 조회 실패 (HTTP ${response.status})`);
        return response;
      } catch (error) {
        if (attempt >= this.retries) throw error;
        await new Promise((resolve) =>
          setTimeout(resolve, 1000 * 2 ** attempt),
        );
      }
    }
  }
  async json(url: string, official = false): Promise<unknown> {
    const response = await this.response(url, official);
    if (
      !(response.headers.get("content-type") ?? "").includes("json") &&
      !url.startsWith(RAW)
    )
      throw new Error("원본에서 JSON 대신 다른 문서를 반환했습니다.");
    const body = await this.bytes(response, 4 * 1024 * 1024);
    return JSON.parse(body.toString("utf8"));
  }
  async bytes(response: Response, maximum: number): Promise<Buffer> {
    if (!response.body) throw new Error("원본 응답이 비어 있습니다.");
    const parts: Buffer[] = [];
    let size = 0;
    const reader = response.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maximum)
          throw new Error("원본 데이터의 크기가 허용 범위를 넘었습니다.");
        parts.push(Buffer.from(value));
      }
    } catch (error) {
      await reader.cancel();
      throw error;
    }
    return Buffer.concat(parts);
  }
  async official(round: number): Promise<Draw[]> {
    const raw = object(
      await this.json(
        `https://www.dhlottery.co.kr/lt645/selectPstLt645InfoNew.do?srchDir=center&srchLtEpsd=${round}`,
        true,
      ),
    );
    const data = object(raw.data);
    if (!Array.isArray(data.list))
      throw new Error("공식 API의 회차 목록 형식이 변경되었습니다.");
    return data.list.map((item) => normalizeDraw(item, "official"));
  }
  async githubInfo(): Promise<{ commit: string; latest: number }> {
    const head = object(await this.json(REPOSITORY + "/commits/main"));
    const commit = String(head.sha ?? "");
    if (!/^[a-f0-9]{40}$/.test(commit))
      throw new Error("GitHub 원본 커밋을 확인할 수 없습니다.");
    const latest = Number(
      object(
        await this.json(
          `${RAW}/${commit}/src/constant/round_no/latest_round_no.json`,
        ),
      ).latest_round_no,
    );
    drawDateFor(latest);
    return { commit, latest };
  }
  async github(round: number, commit: string): Promise<Draw> {
    return normalizeDraw(
      await this.json(`${RAW}/${commit}/src/constant/draw_no/${round}.json`),
      "github",
      round,
      commit,
    );
  }
  async snapshot(commit: string): Promise<{ draws: Draw[]; errors: string[] }> {
    if (!/^[a-f0-9]{40}$/.test(commit))
      throw new Error("원본 커밋이 올바르지 않습니다.");
    const archive = await this.bytes(
      await this.response(
        `https://codeload.github.com/johyunchol/lottogo-python/tar.gz/${commit}`,
      ),
      16 * 1024 * 1024,
    );
    const temp = await mkdtemp(join(tmpdir(), "lotto-source-"));
    const filename = join(temp, "source.tar.gz");
    const draws: Draw[] = [];
    const errors: string[] = [];
    let expanded = 0;
    try {
      await writeFile(filename, archive);
      await tar.t({
        file: filename,
        onReadEntry: (entry) => {
          const matched = /\/src\/constant\/draw_no\/([1-9]\d*)\.json$/.exec(
            entry.path,
          );
          if (!matched) {
            entry.resume();
            return;
          }
          if (entry.size > 65536 || (expanded += entry.size) > 32 * 1024 * 1024)
            throw new Error("원본 회차 파일이 너무 큽니다.");
          const parts: Buffer[] = [];
          entry.on("data", (part) => parts.push(Buffer.from(part)));
          entry.on("end", () => {
            try {
              draws.push(
                normalizeDraw(
                  JSON.parse(Buffer.concat(parts).toString("utf8")),
                  "github",
                  Number(matched[1]),
                  commit,
                ),
              );
            } catch (error) {
              errors.push(
                `${matched[1]}회: ${error instanceof Error ? error.message : "형식 오류"}`,
              );
            }
          });
        },
      });
      if (!draws.length)
        throw new Error("GitHub 원본에서 유효한 회차 파일을 찾지 못했습니다.");
      return { draws: draws.sort((a, b) => a.drawNo - b.drawNo), errors };
    } finally {
      if (
        dirname(resolve(temp)) === resolve(tmpdir()) &&
        temp.includes("lotto-source-")
      )
        await rm(temp, { recursive: true, force: true });
    }
  }
}
