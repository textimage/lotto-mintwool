import "dotenv/config";
import { resolve } from "node:path";
import { Store, databasePath } from "./db.js";
import { SyncEngine, createBackup } from "./sync.js";
import { snapshotDatabase, restoreDatabase } from "./database-files.js";

const command = process.argv[2];
const filename = databasePath(process.env.DATA_DIR ?? "./data");
if (command === "snapshot" || command === "restore") {
  const backup = process.argv[3];
  if (!backup) throw new Error(`${command} <백업경로>를 지정해 주세요.`);
  if (command === "snapshot") {
    const exists = await snapshotDatabase(filename, backup);
    console.log(
      JSON.stringify({
        event: exists ? "snapshot_completed" : "snapshot_missing",
        backup: resolve(backup),
      }),
    );
    // The deploy script distinguishes a fresh volume from a failed backup.
    if (!exists) process.exitCode = 3;
  } else {
    const preserved = await restoreDatabase(filename, backup);
    console.log(
      JSON.stringify({
        event: "restore_completed",
        backup: resolve(backup),
        preserved,
      }),
    );
  }
} else {
  if (!["backup", "sync", "migrate"].includes(command))
    throw new Error(
      "backup, sync, migrate, snapshot 또는 restore 명령을 지정해 주세요.",
    );
  const store = new Store(filename);
  try {
    if (command === "migrate") {
      console.log(
        JSON.stringify({
          event: "migration_completed",
          versions: store.sql
            .prepare("SELECT version FROM migrations ORDER BY version")
            .all(),
        }),
      );
    } else if (command === "backup") {
      await createBackup(store, resolve(process.env.BACKUP_DIR ?? "./backups"));
      console.log("SQLite 백업을 완료했습니다.");
    } else {
      const engine = new SyncEngine(store);
      const job = engine.start("initial");
      await engine.idle();
      const result = store.job(job.id)!;
      console.log(JSON.stringify(result));
      if (result.status === "failed" || result.status === "partial")
        process.exitCode = 1;
    }
  } finally {
    store.close();
  }
}
