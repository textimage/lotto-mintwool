import { Worker } from "node:worker_threads";
import { existsSync } from "node:fs";
import { MAX_IMAGE_BYTES } from "./telegram-api.js";

export class QrDecoder {
  private readonly workers = new Set<Worker>();
  private stopping = false;
  constructor(private readonly timeoutMs = 10000) {}
  async decode(bytes: Buffer): Promise<string> {
    if (this.stopping) throw new Error("QR 처리 중지");
    if (bytes.length > MAX_IMAGE_BYTES)
      throw new Error("사진은 20MB 이하로 보내 주세요.");
    const compiled = new URL("./telegram-qr-worker.js", import.meta.url);
    const worker = existsSync(compiled)
      ? new Worker(compiled, { workerData: bytes })
      : new Worker(
          `import("tsx/esm/api").then(({register}) => { register(); return import(${JSON.stringify(new URL("./telegram-qr-worker.ts", import.meta.url).href)}); }).catch(() => process.exit(1));`,
          {
            eval: true,
            workerData: bytes,
          },
        );
    this.workers.add(worker);
    try {
      return await new Promise<string>((resolve, reject) => {
        const timeout = setTimeout(
          () =>
            reject(
              new Error(
                "QR 인식 시간이 초과되었습니다. QR 부분을 확대해서 다시 보내 주세요.",
              ),
            ),
          this.timeoutMs,
        );
        const finish = (action: () => void) => {
          clearTimeout(timeout);
          action();
        };
        worker.once("message", (message: { raw?: string; error?: string }) =>
          finish(() => {
            if (typeof message.raw === "string") resolve(message.raw);
            else reject(new Error(message.error ?? "QR을 읽지 못했습니다."));
          }),
        );
        worker.once("error", () =>
          finish(() =>
            reject(
              new Error(
                "사진을 처리하지 못했습니다. 원본 사진 파일을 다시 보내 주세요.",
              ),
            ),
          ),
        );
        worker.once("exit", () =>
          finish(() =>
            reject(
              new Error("QR 처리가 중단되었습니다. 사진을 다시 보내 주세요."),
            ),
          ),
        );
      });
    } finally {
      await worker.terminate();
      this.workers.delete(worker);
    }
  }
  async stop() {
    this.stopping = true;
    await Promise.all([...this.workers].map((worker) => worker.terminate()));
  }
}
