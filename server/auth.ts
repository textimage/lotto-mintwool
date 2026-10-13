import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import type { Store } from "./db.js";

const PARAMS = { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 };
async function derive(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(password, salt, 64, PARAMS, (error, key) =>
      error ? reject(error) : resolve(key),
    ),
  );
}
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt);
  return `scrypt$v1$${salt.toString("base64")}$${key.toString("base64")}`;
}
export async function verifyPassword(
  password: string,
  stored: string,
): Promise<boolean> {
  const [algorithm, version, saltText, keyText] = stored.split("$");
  if (algorithm !== "scrypt" || version !== "v1" || !saltText || !keyText)
    return false;
  const expected = Buffer.from(keyText, "base64");
  if (expected.length !== 64) return false;
  const key = await derive(password, Buffer.from(saltText, "base64"));
  return timingSafeEqual(key, expected);
}
export const tokenHash = (token: string) =>
  createHash("sha256").update(token).digest("hex");
export function sessionUser(store: Store, token?: string) {
  if (!token || token.length > 128) return undefined;
  return store.sql
    .prepare(
      "SELECT users.id,users.username FROM sessions JOIN users ON users.id=sessions.user_id WHERE sessions.token_hash=? AND sessions.expires_at>?",
    )
    .get(tokenHash(token), Date.now()) as
    { id: string; username: string } | undefined;
}
export function issueSession(store: Store, userId: string): string {
  const token = randomBytes(32).toString("hex");
  store.sql.prepare("DELETE FROM sessions WHERE expires_at<=?").run(Date.now());
  store.sql
    .prepare("INSERT INTO sessions VALUES(?,?,?)")
    .run(tokenHash(token), userId, Date.now() + 7 * 86400000);
  return token;
}
export function loginLocked(
  store: Store,
  keys: string[],
  now = Date.now(),
): boolean {
  return keys.some((key) => {
    const row = store.sql
      .prepare("SELECT * FROM auth_throttles WHERE key=?")
      .get(key) as { failures: number; started_at: number } | undefined;
    return !!row && row.failures >= 5 && now - row.started_at < 15 * 60000;
  });
}
export function recordFailure(store: Store, keys: string[], now = Date.now()) {
  for (const key of keys) {
    store.sql
      .prepare(
        "INSERT INTO auth_throttles VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET failures=CASE WHEN ?-started_at>=900000 THEN 1 ELSE failures+1 END,started_at=CASE WHEN ?-started_at>=900000 THEN ? ELSE started_at END",
      )
      .run(key, now, now, now, now);
  }
}
