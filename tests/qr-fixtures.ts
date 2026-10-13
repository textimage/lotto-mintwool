import { BarcodeFormat, QRCodeWriter } from "@zxing/library";
import { qrRootSample } from "./fixtures.js";

export function noisyQrPixels() {
  const matrix = new QRCodeWriter().encode(
    qrRootSample,
    BarcodeFormat.QR_CODE,
    700,
    700,
    new Map(),
  );
  const width = matrix.getWidth(),
    height = matrix.getHeight();
  const pixels = new Uint8ClampedArray(width * height);
  let seed = 3;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const value = matrix.get(x, y) ? 0 : 255;
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      pixels[y * width + x] = seed / 0x1_0000_0000 < 0.08 ? 255 - value : value;
    }
  }
  return { pixels, width, height };
}
