import "dotenv/config";
import { TelegramApi, TelegramError } from "../server/telegram-api.js";
import type { TelegramUpdate } from "../server/telegram.js";

try {
  const token = process.env.TELEGRAM_BOT_TOKEN ?? "";
  if (!/^\d+:[\w-]{20,}$/.test(token))
    throw new Error("TELEGRAM_BOT_TOKEN을 서버 .env에 설정해 주세요.");
  const api = new TelegramApi(token);
  const me = await api.call<{ username: string }>("getMe");
  const webhook = await api.call<{ url: string }>("getWebhookInfo");
  console.log(`봇 확인: @${me.username}`);
  if (webhook.url)
    throw new Error(
      "기존 webhook이 있습니다. 기존 연동을 종료하고 deleteWebhook으로 해제해 주세요.",
    );
  if (process.argv.includes("--identify")) {
    console.log(
      "봇 서비스가 중지된 상태에서 본인 텔레그램 개인 대화에 /start를 보내 주세요.",
    );
    const updates = await api.call<TelegramUpdate[]>("getUpdates", {
      timeout: 30,
      allowed_updates: ["message"],
    });
    const ids = new Set(
      updates
        .filter(
          (u) => u.message?.chat.type === "private" && !u.message.from?.is_bot,
        )
        .map((u) => String(u.message!.from!.id)),
    );
    if (!ids.size)
      console.log(
        "개인 대화 메시지가 없습니다. /start를 보낸 뒤 다시 실행해 주세요.",
      );
    for (const id of ids) console.log(`개인 대화 사용자 ID: ${id}`);
  } else
    console.log(
      "사용자 ID 확인: 같은 명령에 --identify를 추가하세요. (봇 서비스 중지 필요)",
    );
} catch (error) {
  console.error(
    error instanceof TelegramError
      ? error.message
      : error instanceof Error
        ? error.message
        : "텔레그램 설정 확인 실패",
  );
  process.exitCode = 1;
}
