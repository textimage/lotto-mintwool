import "dotenv/config";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import cron from "node-cron";
import { Store, databasePath } from "./db.js";
import { createApp } from "./app.js";
import { SyncEngine, createBackup } from "./sync.js";
import { configuredTelegramBot } from "./telegram.js";

const store = new Store(databasePath(process.env.DATA_DIR ?? "./data"));
store.bootstrap(
  process.env.BOOTSTRAP_USERNAME ?? "textimage",
  process.env.BOOTSTRAP_PASSWORD_HASH,
);
const engine = new SyncEngine(store);
const backups = resolve(process.env.BACKUP_DIR ?? "./backups");
const production = process.env.NODE_ENV === "production";
const origin = process.env.APP_ORIGIN ?? "https://lotto.mintwool.com";
if (production && !origin.startsWith("https://"))
  throw new Error("운영 APP_ORIGIN에는 HTTPS 주소가 필요합니다.");
const app = createApp(store, engine, {
  production,
  origin,
  trustProxy: production,
  backupDirectory: backups,
});
const client = resolve(process.env.STATIC_DIR ?? "./dist/client");
app.get("/api/*", (c) => c.json({ error: "API 경로를 찾지 못했습니다." }, 404));
if (existsSync(client)) {
  app.use("*", serveStatic({ root: client }));
  app.get("*", serveStatic({ path: resolve(client, "index.html") }));
}
const port = Number(process.env.PORT ?? 3000);
const server = serve({
  fetch: app.fetch,
  port,
  hostname: production ? "0.0.0.0" : "127.0.0.1",
});
console.log(
  JSON.stringify({
    event: "server_started",
    url: `http://127.0.0.1:${port}`,
    production,
  }),
);
const sync = () => {
  if (store.settings().autoSync)
    engine.start(store.draws().length ? "latest" : "initial");
};
const cronOptions = { timezone: "Asia/Seoul", noOverlap: true };
const tasks = [
  cron.schedule("45 20 * * 6", sync, cronOptions),
  cron.schedule("*/15 21-23 * * 6", sync, cronOptions),
  cron.schedule("*/15 0-2 * * 0", sync, cronOptions),
  cron.schedule("0 3 * * *", sync, cronOptions),
  cron.schedule(
    "30 3 * * *",
    async () => {
      try {
        await createBackup(store, backups);
        console.log(JSON.stringify({ event: "backup_completed" }));
      } catch (error) {
        console.error(
          JSON.stringify({
            event: "backup_failed",
            message: error instanceof Error ? error.message : "오류",
          }),
        );
      }
    },
    cronOptions,
  ),
];
if (store.activeJob()) engine.resume();
else sync();
const telegram = configuredTelegramBot(store, engine, origin);
if (telegram)
  void telegram.start().catch(async () => {
    console.error(
      JSON.stringify({
        event: "telegram_start_failed",
        hint: "토큰, 사용자 ID, 사이트 사용자명, 기존 webhook 설정을 확인해 주세요.",
      }),
    );
    await telegram.stop();
  });
let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  for (const task of tasks) task.stop();
  const closed = new Promise<void>((resolve) => server.close(() => resolve()));
  await Promise.all([engine.stop(), telegram?.stop()]);
  await closed;
  store.close();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
