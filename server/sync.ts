import { readdir, unlink } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import {
  publishedCandidate,
  type Draw,
  type SyncJob,
} from "../shared/domain.js";
import { Store } from "./db.js";
import { Sources } from "./sources.js";

export class SyncEngine {
  private running: Promise<void> | null = null;
  private stopping = false;
  constructor(
    readonly store: Store,
    readonly sources = new Sources(),
    readonly now: () => Date = () => new Date(),
  ) {}
  start(
    mode: SyncJob["mode"],
    range: { from?: number; to?: number } = {},
  ): SyncJob {
    const job = this.store.createJob(mode, range);
    this.wake();
    return job;
  }
  resume() {
    this.wake();
  }
  wake() {
    if (this.running || this.stopping || !this.store.activeJob()) return;
    this.running = this.execute().finally(() => {
      this.running = null;
    });
  }
  async idle() {
    await this.running;
  }
  async stop() {
    this.stopping = true;
    await this.running;
  }
  private async latest(): Promise<{
    latest: number;
    official: Draw[];
    info: { commit: string; latest: number } | null;
  }> {
    const candidate = Math.max(1, publishedCandidate(this.now()));
    for (const round of [candidate, Math.max(1, candidate - 1)]) {
      try {
        const official = (await this.sources.official(round)).filter(
          (d) => d.drawNo <= candidate,
        );
        if (official.length)
          return {
            latest: Math.max(...official.map((d) => d.drawNo)),
            official,
            info: null,
          };
      } catch {
        break;
      }
    }
    const info = await this.sources.githubInfo();
    return { latest: Math.min(info.latest, candidate), official: [], info };
  }
  private async execute() {
    const job = this.store.activeJob();
    if (!job) return;
    let work = this.store.work(job.id);
    const fetched = new Map<number, Draw>();
    try {
      job.status = "running";
      this.store.updateJob(job);
      let snapshot: Draw[] | null = null;
      if (job.mode === "initial" && work.phase !== "repair") {
        try {
          const commit =
            typeof work.commit === "string"
              ? work.commit
              : (await this.sources.githubInfo()).commit;
          work.commit = commit;
          this.store.updateJob(job, work);
          const source = await this.sources.snapshot(commit);
          snapshot = source.draws.filter(
            (d) => d.drawNo <= publishedCandidate(this.now()),
          );
          job.errors.push(...source.errors);
          job.total = snapshot.length;
          this.store.updateJob(job, work);
          for (
            let offset = job.processed;
            offset < snapshot.length;
            offset += 50
          ) {
            if (this.stopping) return;
            const batch = snapshot.slice(offset, offset + 50);
            this.store.sql.transaction(() => {
              for (const draw of batch)
                if (this.store.upsertDraw(draw)) job.saved++;
              job.processed = offset + batch.length;
              this.store.updateJob(job);
            })();
            await new Promise<void>((resolve) => setImmediate(resolve));
          }
        } catch (error) {
          job.errors.push(
            "초기 GitHub 수집: " +
              (error instanceof Error ? error.message : "오류"),
          );
        }
      }
      const discovery = await this.latest();
      for (const draw of discovery.official) {
        fetched.set(draw.drawNo, draw);
        if (this.store.upsertDraw(draw)) job.saved++;
      }
      if (!Array.isArray(work.targets)) {
        let targets: number[];
        if (job.mode === "range") {
          const from = Number(work.from),
            to = Number(work.to);
          if (
            !Number.isInteger(from) ||
            !Number.isInteger(to) ||
            from < 1 ||
            to < from ||
            to > discovery.latest
          )
            throw new Error(
              `재조회 범위는 1~${discovery.latest}회 안에서 지정해 주세요.`,
            );
          targets = Array.from({ length: to - from + 1 }, (_, i) => from + i);
        } else {
          const existing = new Map(
            this.store.draws().map((d) => [d.drawNo, d]),
          );
          const needed = new Set<number>();
          for (let i = 1; i <= discovery.latest; i++)
            if (existing.get(i)?.status !== "complete") needed.add(i);
          if (job.mode !== "missing") {
            needed.add(discovery.latest);
            if (discovery.latest > 1) needed.add(discovery.latest - 1);
          }
          targets = [...needed].sort((a, b) => a - b);
        }
        work = {
          ...work,
          phase: "repair",
          targets,
          index: 0,
          baseProcessed: job.processed,
        };
        job.total = job.processed + targets.length;
        this.store.updateJob(job, work);
      }
      const targets = work.targets as number[];
      let info = discovery.info;
      for (
        let index = Number(work.index ?? 0);
        index < targets.length;
        index++
      ) {
        if (this.stopping) return;
        const round = targets[index];
        try {
          if (!fetched.has(round)) {
            const skip =
              job.mode !== "range" &&
              this.store.draw(round)?.status === "complete" &&
              round < discovery.latest - 1;
            if (!skip) {
              let official: Draw[] = [];
              try {
                official = await this.sources.official(round);
                if (!official.some((d) => d.drawNo === round))
                  throw new Error("공식 응답에 요청 회차가 없습니다.");
              } catch {
                info ??= await this.sources.githubInfo();
                const fallback = await this.sources.github(round, info.commit);
                if (this.store.upsertDraw(fallback)) job.saved++;
                fetched.set(round, fallback);
                job.fallbackCount++;
              }
              for (const draw of official.filter(
                (d) => d.drawNo <= discovery.latest,
              )) {
                if (this.store.upsertDraw(draw)) job.saved++;
                fetched.set(draw.drawNo, draw);
              }
            }
          }
          if (this.store.draw(round)?.status !== "complete")
            job.errors.push(
              `${round}회차: 당첨금 집계가 미확정입니다. 다음 갱신에서 재조회합니다.`,
            );
        } catch (error) {
          job.errors.push(
            `${round}회차: ${error instanceof Error ? error.message : "수집 오류"}`,
          );
        }
        work.index = index + 1;
        job.processed = Number(work.baseProcessed ?? 0) + index + 1;
        this.store.updateJob(job, work);
        await new Promise((resolve) => setTimeout(resolve, 80));
      }
      const draws = new Map(this.store.draws().map((d) => [d.drawNo, d]));
      const gaps = Array.from(
        { length: discovery.latest },
        (_, i) => i + 1,
      ).filter((n) => !draws.has(n));
      if (gaps.length)
        job.errors.push(
          `아직 누락된 회차: ${gaps.slice(0, 20).join(", ")}${gaps.length > 20 ? " 외 " + (gaps.length - 20) + "개" : ""}`,
        );
      job.status = job.errors.length ? "partial" : "completed";
    } catch (error) {
      job.status = "failed";
      job.errors.push(error instanceof Error ? error.message : "동기화 오류");
    }
    job.finishedAt = new Date().toISOString();
    this.store.updateJob(job, work);
    console.log(
      JSON.stringify({
        event: "sync_finished",
        jobId: job.id,
        status: job.status,
        processed: job.processed,
        saved: job.saved,
        fallbackCount: job.fallbackCount,
      }),
    );
  }
}

export async function createBackup(
  store: Store,
  directory: string,
): Promise<string> {
  const filename = await store.snapshot(directory);
  const files = (await readdir(directory))
    .filter((name) => /^lotto-[\dTZ-]+\.sqlite$/.test(name))
    .sort()
    .reverse();
  for (const old of files.slice(14)) {
    const path = resolve(directory, old);
    if (dirname(path) === resolve(directory)) await unlink(path);
  }
  return filename;
}
