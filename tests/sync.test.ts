import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, copyFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { Store } from "../server/db.js";
import { SyncEngine, createBackup } from "../server/sync.js";
import { Sources } from "../server/sources.js";
import { hashPassword, verifyPassword } from "../server/auth.js";
import type { Draw } from "../shared/domain.js";
import { draw } from "./fixtures.js";

class MockSources extends Sources {
  latestRound = 3;
  outage = false;
  malformed = false;
  tallied = true;
  failSnapshot = false;
  calls: number[] = [];
  constructor() {
    super(async () => {
      throw new Error("Network must not be used in tests.");
    }, 0);
  }
  override async githubInfo() {
    return { commit: "a".repeat(40), latest: this.latestRound };
  }
  override async github(round: number) {
    return draw(round, "github");
  }
  override async snapshot() {
    if (this.failSnapshot) throw new Error("archive unavailable");
    return { draws: [draw(1, "github")], errors: [] };
  }
  override async official(round: number): Promise<Draw[]> {
    this.calls.push(round);
    if (this.outage) throw new Error("upstream down");
    if (this.malformed) return [];
    const rows = Array.from({ length: this.latestRound }, (_, i) =>
      draw(i + 1),
    );
    if (!this.tallied) {
      rows.at(-1)!.status = "numbers_only";
      rows.at(-1)!.ranks.forEach((r) => {
        r.numWinners = null;
        r.prizePerGame = null;
        r.totalPrizeAmount = null;
      });
    }
    return rows;
  }
}
const now = () => new Date("2002-12-22T12:00:00+09:00");

test("initial import fills gaps, verifies latest and does not duplicate draws on a repeat", async () => {
  const store = new Store(":memory:");
  const sources = new MockSources();
  const engine = new SyncEngine(store, sources, now);
  try {
    const job = engine.start("initial");
    assert.equal(engine.start("missing").id, job.id);
    await engine.idle();
    assert.equal(store.job(job.id)!.status, "completed");
    assert.equal(store.draws().length, 3);
    const repeat = engine.start("initial");
    await engine.idle();
    assert.equal(store.draws().length, 3);
    assert.equal(store.job(repeat.id)!.status, "completed");
  } finally {
    store.close();
  }
});
test("unavailable official API uses exact GitHub files and records fallback provenance", async () => {
  const store = new Store(":memory:");
  const sources = new MockSources();
  sources.outage = true;
  const engine = new SyncEngine(store, sources, now);
  try {
    const job = engine.start("latest");
    await engine.idle();
    assert.equal(store.job(job.id)!.status, "completed");
    assert.equal(store.job(job.id)!.fallbackCount, 3);
    assert.equal(store.draw(2)!.source, "github");
    assert.equal(store.draw(2)!.sourceCommit, "a".repeat(40));
  } finally {
    store.close();
  }
});
test("delayed tally is retried even when its numbers already exist", async () => {
  const store = new Store(":memory:");
  const sources = new MockSources();
  sources.tallied = false;
  const engine = new SyncEngine(store, sources, now);
  try {
    const first = engine.start("latest");
    await engine.idle();
    assert.equal(store.draw(3)!.status, "numbers_only");
    assert.equal(store.job(first.id)!.status, "partial");
    sources.tallied = true;
    const second = engine.start("missing");
    await engine.idle();
    assert.equal(store.draw(3)!.status, "complete");
    assert.equal(store.job(second.id)!.status, "completed");
  } finally {
    store.close();
  }
});
test("complete official data survives incomplete and older fallback responses", () => {
  const store = new Store(":memory:");
  try {
    const correct = draw(3);
    store.upsertDraw(correct);
    const partial = draw(3);
    partial.status = "numbers_only";
    partial.ranks[0].prizePerGame = null;
    assert.equal(store.upsertDraw(partial), false);
    const fallback = draw(3, "github");
    fallback.ranks[0].prizePerGame = 123;
    assert.equal(store.upsertDraw(fallback), false);
    assert.equal(store.draw(3)!.ranks[0].prizePerGame, 3000000000);
  } finally {
    store.close();
  }
});
test("initial import can recover through official API when the GitHub archive is unavailable", async () => {
  const store = new Store(":memory:");
  const sources = new MockSources();
  sources.failSnapshot = true;
  const engine = new SyncEngine(store, sources, now);
  try {
    const job = engine.start("initial");
    await engine.idle();
    assert.equal(store.draws().length, 3);
    assert.ok(
      store.job(job.id)!.errors.some((e) => e.includes("archive unavailable")),
    );
  } finally {
    store.close();
  }
});
test("source failure is surfaced, and a requested range beyond published data is rejected", async () => {
  const store = new Store(":memory:");
  const sources = new MockSources();
  const engine = new SyncEngine(store, sources, now);
  try {
    const job = engine.start("range", { from: 1, to: 4 });
    await engine.idle();
    assert.equal(store.job(job.id)!.status, "failed");
    assert.ok(store.job(job.id)!.errors[0].includes("1~3"));
    sources.outage = true;
    sources.githubInfo = async () => {
      throw new Error("all upstreams down");
    };
    const failure = engine.start("latest");
    await engine.idle();
    assert.equal(store.job(failure.id)!.status, "failed");
    assert.ok(store.job(failure.id)!.errors.includes("all upstreams down"));
  } finally {
    store.close();
  }
});
test("durable job state resumes after a database reopen; existing account and settings persist", async () => {
  const temp = await mkdtemp(join(tmpdir(), "lotto-test-"));
  const file = join(temp, "data.sqlite");
  const passwordHash = await hashPassword("persist-password!");
  try {
    let store = new Store(file);
    store.bootstrap("textimage", passwordHash);
    store.saveSettings({ autoSync: false });
    store.upsertDraw(draw(1));
    const job = store.createJob("range", {
      phase: "repair",
      targets: [1, 2, 3],
      index: 1,
      baseProcessed: 0,
      from: 1,
      to: 3,
    });
    job.status = "running";
    job.total = 3;
    job.processed = 1;
    store.updateJob(job);
    store.close();
    store = new Store(file);
    store.bootstrap("ignored-user", await hashPassword("ignored-password!"));
    const sources = new MockSources();
    const engine = new SyncEngine(store, sources, now);
    engine.resume();
    await engine.idle();
    assert.equal(store.job(job.id)!.status, "completed");
    assert.equal(store.job(job.id)!.processed, 3);
    assert.equal(store.settings().autoSync, false);
    const account = store.sql
      .prepare("SELECT username,password_hash FROM users")
      .get() as { username: string; password_hash: string };
    assert.equal(account.username, "textimage");
    assert.ok(await verifyPassword("persist-password!", account.password_hash));
    store.close();
  } finally {
    if (
      dirname(resolve(temp)) === resolve(tmpdir()) &&
      temp.includes("lotto-test-")
    )
      await rm(temp, { recursive: true, force: true });
  }
});
test("online snapshots restore consistent data and retention only removes owned backup files", async () => {
  const temp = await mkdtemp(join(tmpdir(), "lotto-test-"));
  const store = new Store(join(temp, "main.sqlite"));
  const directory = join(temp, "backups");
  try {
    store.upsertDraw(draw());
    const snapshot = await createBackup(store, directory);
    await writeFile(join(directory, "keep-me.txt"), "unrelated");
    for (let i = 1; i <= 15; i++)
      await copyFile(
        snapshot,
        join(
          directory,
          `lotto-2000-01-${String(i).padStart(2, "0")}T00-00-00-000Z.sqlite`,
        ),
      );
    const newest = await createBackup(store, directory);
    const files = await readdir(directory);
    assert.equal(files.filter((f) => f.endsWith(".sqlite")).length, 14);
    assert.ok(files.includes("keep-me.txt"));
    const restored = new Store(newest);
    assert.deepEqual(restored.draw(1245)!.numbers, [1, 2, 3, 4, 5, 6]);
    restored.close();
  } finally {
    store.close();
    if (
      dirname(resolve(temp)) === resolve(tmpdir()) &&
      temp.includes("lotto-test-")
    )
      await rm(temp, { recursive: true, force: true });
  }
});
