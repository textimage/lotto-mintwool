import { readFile, writeFile, chmod } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { hashPassword } from "../server/auth.js";

async function hiddenInput(): Promise<{ username: string; password: string }> {
  if (process.argv.includes("--stdin")) {
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdout.write("Ready for admin JSON on stdin (input is hidden).\n");
    const line = await new Promise<string>((resolve, reject) => {
      let buffer = "";
      process.stdin.setEncoding("utf8");
      const handler = (chunk: string) => {
        if (chunk.includes("\u0003")) {
          process.stdin.off("data", handler);
          reject(new Error("취소되었습니다."));
          return;
        }
        buffer += chunk;
        if (buffer.includes("\n") || buffer.includes("\r")) {
          process.stdin.off("data", handler);
          resolve(buffer.split(/[\r\n]/)[0]);
        }
      };
      process.stdin.on("data", handler);
      process.stdin.resume();
    });
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdin.pause();
    return JSON.parse(line);
  }
  const input = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const username =
    (await input.question("초기 아이디 [textimage]: ")).trim() || "textimage";
  input.close();
  if (!process.stdin.isTTY)
    throw new Error("--stdin 모드에서 JSON을 전달해 주세요.");
  process.stdout.write("초기 비밀번호 (입력은 표시되지 않습니다): ");
  process.stdin.setRawMode(true);
  process.stdin.setEncoding("utf8");
  process.stdin.resume();
  const password = await new Promise<string>((resolve, reject) => {
    let result = "";
    const handler = (chunk: string) => {
      for (const char of chunk) {
        if (char === "\u0003") {
          process.stdin.off("data", handler);
          reject(new Error("취소되었습니다."));
          return;
        }
        if (char === "\r" || char === "\n") {
          process.stdin.off("data", handler);
          resolve(result);
          return;
        }
        if (char === "\u007f" || char === "\b") result = result.slice(0, -1);
        else result += char;
      }
    };
    process.stdin.on("data", handler);
  });
  process.stdin.setRawMode(false);
  process.stdin.pause();
  process.stdout.write("\n");
  return { username, password };
}
const { username, password } = await hiddenInput();
if (
  !/^[A-Za-z0-9_-]{3,80}$/.test(username) ||
  typeof password !== "string" ||
  password.length < 8 ||
  password.length > 256
)
  throw new Error("아이디는 3~80자, 비밀번호는 8~256자로 입력해 주세요.");
let configuration = "";
try {
  configuration = await readFile(".env", "utf8");
} catch {
  configuration =
    "APP_DOMAIN=lotto.mintwool.com\nAPP_ORIGIN=https://lotto.mintwool.com\nDATA_DIR=./data\nBACKUP_DIR=./backups\n";
}
const hash = await hashPassword(password);
for (const [key, value] of Object.entries({
  BOOTSTRAP_USERNAME: username,
  BOOTSTRAP_PASSWORD_HASH: hash,
})) {
  const expression = new RegExp("^" + key + "=.*$", "m");
  const encoded = key === "BOOTSTRAP_PASSWORD_HASH" ? "'" + value + "'" : value;
  configuration = expression.test(configuration)
    ? configuration.replace(expression, () => key + "=" + encoded)
    : configuration.trimEnd() + "\n" + key + "=" + encoded + "\n";
}
await writeFile(".env", configuration, { mode: 0o600 });
await chmod(".env", 0o600);
console.log(
  "초기 계정의 암호 해시를 .env에 저장했습니다. 기존 DB의 계정은 재설정되지 않습니다.",
);
process.stdin.destroy();
