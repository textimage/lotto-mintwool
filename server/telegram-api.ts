export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

export class TelegramError extends Error {
  constructor(
    readonly code: number,
    readonly retryAfter = 0,
  ) {
    super(`Telegram API 오류 (${code})`);
  }
}
export interface TelegramTransport {
  call<T>(
    method: string,
    parameters?: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<T>;
  download(fileId: string, signal?: AbortSignal): Promise<Buffer>;
}

export class TelegramApi implements TelegramTransport {
  constructor(
    private readonly token: string,
    private readonly request: typeof fetch = fetch,
  ) {}
  async call<T>(
    method: string,
    parameters: Record<string, unknown> = {},
    signal?: AbortSignal,
  ): Promise<T> {
    try {
      const response = await this.request(
        `https://api.telegram.org/bot${this.token}/${method}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(parameters),
          signal: AbortSignal.any([
            AbortSignal.timeout(45000),
            ...(signal ? [signal] : []),
          ]),
        },
      );
      const body = (await response.json()) as {
        ok?: boolean;
        result?: T;
        error_code?: number;
        parameters?: { retry_after?: number };
      };
      if (!response.ok || !body.ok) {
        const code = Number.isInteger(body.error_code)
          ? body.error_code!
          : response.status;
        const retry = Number(body.parameters?.retry_after);
        throw new TelegramError(
          code,
          Number.isFinite(retry) && retry > 0 ? retry : 0,
        );
      }
      return body.result as T;
    } catch (error) {
      if (error instanceof TelegramError) throw error;
      // fetch errors can contain the token-bearing URL. Never retain that error.
      throw new TelegramError(0);
    }
  }
  async download(fileId: string, signal?: AbortSignal): Promise<Buffer> {
    const file = await this.call<{ file_path?: string; file_size?: number }>(
      "getFile",
      { file_id: fileId },
      signal,
    );
    if ((file.file_size ?? 0) > MAX_IMAGE_BYTES)
      throw new Error("사진은 20MB 이하로 보내 주세요.");
    if (
      !file.file_path ||
      !/^[a-zA-Z0-9_./-]+$/.test(file.file_path) ||
      file.file_path.startsWith("/") ||
      file.file_path.split("/").includes("..")
    )
      throw new TelegramError(0);
    try {
      const response = await this.request(
        `https://api.telegram.org/file/bot${this.token}/${file.file_path}`,
        {
          signal: AbortSignal.any([
            AbortSignal.timeout(30000),
            ...(signal ? [signal] : []),
          ]),
        },
      );
      if (!response.ok || !response.body)
        throw new TelegramError(response.status);
      if (Number(response.headers.get("content-length")) > MAX_IMAGE_BYTES)
        throw new Error("사진은 20MB 이하로 보내 주세요.");
      const reader = response.body.getReader();
      const parts: Buffer[] = [];
      let size = 0;
      try {
        for (;;) {
          const item = await reader.read();
          if (item.done) break;
          size += item.value.byteLength;
          if (size > MAX_IMAGE_BYTES)
            throw new Error("사진은 20MB 이하로 보내 주세요.");
          parts.push(Buffer.from(item.value));
        }
      } catch (error) {
        await reader.cancel().catch(() => {});
        throw error;
      }
      return Buffer.concat(parts);
    } catch (error) {
      if (
        error instanceof TelegramError ||
        (error instanceof Error &&
          error.message === "사진은 20MB 이하로 보내 주세요.")
      )
        throw error;
      throw new TelegramError(0);
    }
  }
}
