import { BrowserQRCodeReader } from "@zxing/browser";
import { DecodeHintType, type Result } from "@zxing/library";
import {
  decodeQrLuminance,
  qrDecodeFailure,
  qrImageSizes,
  rgbaLuminance,
} from "../shared/qr-image";

export class LottoQrReader extends BrowserQRCodeReader {
  private lastRecovery = -Infinity;
  private recoveryCanvas: HTMLCanvasElement | null = null;

  constructor(private readonly recoveryIntervalMs = 0) {
    super(new Map([[DecodeHintType.TRY_HARDER, true]]));
  }

  override decodeFromCanvas(canvas: HTMLCanvasElement): Result {
    try {
      return super.decodeFromCanvas(canvas);
    } catch (error) {
      if (
        !qrDecodeFailure(error) ||
        performance.now() - this.lastRecovery < this.recoveryIntervalMs
      )
        throw error;

      const recovery = (this.recoveryCanvas ??=
        document.createElement("canvas"));
      const context = recovery.getContext("2d", { willReadFrequently: true });
      if (!context) throw error;
      try {
        for (const size of qrImageSizes(canvas.width, canvas.height)) {
          const scale = size / Math.max(canvas.width, canvas.height);
          recovery.width = Math.max(1, Math.round(canvas.width * scale));
          recovery.height = Math.max(1, Math.round(canvas.height * scale));
          context.imageSmoothingEnabled = true;
          context.imageSmoothingQuality = "high";
          context.fillStyle = "#ffffff";
          context.fillRect(0, 0, recovery.width, recovery.height);
          context.drawImage(canvas, 0, 0, recovery.width, recovery.height);
          const pixels = context.getImageData(
            0,
            0,
            recovery.width,
            recovery.height,
          );
          const result = decodeQrLuminance(
            rgbaLuminance(pixels.data),
            recovery.width,
            recovery.height,
          );
          if (result) return result;
        }
        throw error;
      } finally {
        this.lastRecovery = performance.now();
      }
    }
  }
}
