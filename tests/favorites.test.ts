import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Store } from "../server/db.js";

test("simultaneous processes serialize favorite checks and inserts on the same SQLite database", async () => {
  const directory = mkdtempSync(join(tmpdir(), "lotto-favorites-"));
  const filename = join(directory, "lotto.sqlite");
  const store = new Store(filename);
  store.bootstrap("test-owner", "test-hash");
  const user = store.sql.prepare("SELECT id FROM users").get() as {
    id: string;
  };
  store.close();
  const script = `
    import { Store } from ${JSON.stringify(new URL("../server/db.ts", import.meta.url).href)};
    const store = new Store(process.argv[1]);
    try {
      const result = store.ensureFavorite(process.argv[2], [6,5,4,3,2,1]);
      process.stdout.write(JSON.stringify(result));
    } finally { store.close(); }
  `;
  async function save(): Promise<{
    created: boolean;
    favorite: { id: string };
  }> {
    return new Promise((accept, reject) => {
      const child = spawn(process.execPath, [
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        script,
        filename,
        user.id,
      ]);
      let output = "";
      let errors = "";
      child.stdout.on("data", (data) => {
        output += String(data);
      });
      child.stderr.on("data", (data) => {
        errors += String(data);
      });
      child.on("error", reject);
      child.on("exit", (code) => {
        if (code !== 0) reject(new Error(errors || `Child exited ${code}`));
        else {
          try {
            accept(JSON.parse(output));
          } catch (error) {
            reject(error);
          }
        }
      });
    });
  }
  try {
    const attempts = await Promise.allSettled(Array.from({ length: 4 }, save));
    const results = attempts.map((attempt) => {
      if (attempt.status === "rejected") throw attempt.reason;
      return attempt.value;
    });
    assert.equal(results.filter((result) => result.created).length, 1);
    assert.equal(new Set(results.map((result) => result.favorite.id)).size, 1);
    const reopened = new Store(filename);
    try {
      assert.equal(reopened.favorites(user.id).length, 1);
      assert.deepEqual(
        reopened.favorites(user.id)[0].numbers,
        [1, 2, 3, 4, 5, 6],
      );
    } finally {
      reopened.close();
    }
  } finally {
    assert.equal(dirname(directory), resolve(tmpdir()));
    rmSync(directory, { recursive: true, force: true });
  }
});
