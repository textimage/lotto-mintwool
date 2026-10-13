import Database from "better-sqlite3";
import {
  chmodSync,
  copyFileSync,
  constants,
  existsSync,
  mkdirSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";

function validate(sql: Database.Database) {
  const check = sql.pragma("quick_check") as { quick_check: string }[];
  if (
    check.length !== 1 ||
    check[0].quick_check !== "ok" ||
    (sql.pragma("foreign_key_check") as unknown[]).length
  )
    throw new Error("SQLite 백업 무결성 검증에 실패했습니다.");
}

function finishCopy(filename: string) {
  const sql = new Database(filename, { fileMustExist: true });
  try {
    // Publish a self-contained file, with no WAL sidecars to copy or restore.
    sql.pragma("journal_mode = DELETE");
    validate(sql);
  } finally {
    sql.close();
  }
  chmodSync(filename, 0o600);
}

/** No Store construction: backing up an old DB must never upgrade its schema. */
export async function snapshotDatabase(
  databaseFilename: string,
  backupFilename: string,
): Promise<boolean> {
  const filename = resolve(databaseFilename);
  const backup = resolve(backupFilename);
  if (filename === backup) throw new Error("DB와 백업 경로가 같습니다.");
  if (!existsSync(filename)) return false;
  if (existsSync(backup)) throw new Error("기존 백업을 덮어쓸 수 없습니다.");
  mkdirSync(dirname(backup), { recursive: true, mode: 0o700 });
  const temporary = `${backup}.tmp-${randomUUID()}`;
  const sql = new Database(filename, { readonly: true, fileMustExist: true });
  try {
    await sql.backup(temporary);
    finishCopy(temporary);
    // Publish only a validated copy and never overwrite an earlier backup.
    copyFileSync(temporary, backup, constants.COPYFILE_EXCL);
    return true;
  } finally {
    sql.close();
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

/** Requires the app and every other DB writer to be stopped. */
export async function restoreDatabase(
  databaseFilename: string,
  backupFilename: string,
): Promise<string | undefined> {
  const filename = resolve(databaseFilename);
  const backup = resolve(backupFilename);
  if (filename === backup) throw new Error("DB와 백업 경로가 같습니다.");
  const source = new Database(backup, { readonly: true, fileMustExist: true });
  const temporary = `${filename}.restore-${randomUUID()}`;
  let preserved: string | undefined;
  try {
    validate(source);
    mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
    await source.backup(temporary);
    finishCopy(temporary);
    if (existsSync(filename)) {
      const current = new Database(filename, { fileMustExist: true });
      try {
        current.pragma("busy_timeout = 5000");
        const checkpoint = current.pragma("wal_checkpoint(TRUNCATE)") as {
          busy: number;
        }[];
        if (checkpoint.some((row) => row.busy !== 0))
          throw new Error("DB가 사용 중입니다. 앱을 중지한 뒤 복구해 주세요.");
      } finally {
        current.close();
      }
      if (existsSync(`${filename}-wal`) || existsSync(`${filename}-shm`))
        throw new Error(
          "DB WAL 연결이 남아 있습니다. 모든 DB 연결을 종료해 주세요.",
        );
      preserved = `${filename}.before-restore-${randomUUID()}`;
      copyFileSync(filename, preserved, constants.COPYFILE_EXCL);
      chmodSync(preserved, 0o600);
    }
    renameSync(temporary, filename);
    return preserved;
  } finally {
    source.close();
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}
