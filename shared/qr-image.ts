import {
  BinaryBitmap,
  ChecksumException,
  DecodeHintType,
  FormatException,
  GlobalHistogramBinarizer,
  HybridBinarizer,
  NotFoundException,
  QRCodeReader,
  RGBLuminanceSource,
  type Result,
} from "@zxing/library";

export function qrImageSizes(width: number, height: number): number[] {
  const largest = Math.max(width, height);
  return [
    ...new Set(
      [3000, 1800, 1200, 1000, 700].map((size) => Math.min(size, largest)),
    ),
  ];
}

export function qrDecodeFailure(error: unknown): boolean {
  return (
    error instanceof NotFoundException ||
    error instanceof ChecksumException ||
    error instanceof FormatException
  );
}

export function rgbaLuminance(data: Uint8ClampedArray): Uint8ClampedArray {
  const luminance = new Uint8ClampedArray(data.length / 4);
  for (let i = 0; i < luminance.length; i++) {
    const offset = i * 4;
    luminance[i] =
      data[offset + 3] === 0
        ? 255
        : (306 * data[offset] +
            601 * data[offset + 1] +
            117 * data[offset + 2] +
            512) >>
          10;
  }
  return luminance;
}

function medianLuminance(
  input: Uint8ClampedArray,
  width: number,
  height: number,
) {
  const output = new Uint8ClampedArray(input);
  const neighbors = new Uint8Array(9);
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      let index = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          neighbors[index++] = input[(y + dy) * width + x + dx];
        }
      }
      neighbors.sort();
      output[y * width + x] = neighbors[4];
    }
  }
  return output;
}

export function decodeQrLuminance(
  luminance: Uint8ClampedArray,
  width: number,
  height: number,
): Result | null {
  // Preserve sharp edges first. A median pass repairs isolated light/dark pixels
  // in textured paper and compressed photos without guessing any QR data.
  const reader = new QRCodeReader();
  const hints = new Map<DecodeHintType, unknown>([
    [DecodeHintType.TRY_HARDER, true],
  ]);
  for (const denoise of [false, true]) {
    const pixels = denoise
      ? medianLuminance(luminance, width, height)
      : luminance;
    const source = new RGBLuminanceSource(pixels, width, height);
    for (const candidate of [source, source.invert()]) {
      for (const Binarizer of [HybridBinarizer, GlobalHistogramBinarizer]) {
        try {
          return reader.decode(
            new BinaryBitmap(new Binarizer(candidate)),
            hints,
          );
        } catch (error) {
          if (!qrDecodeFailure(error)) throw error;
        }
      }
    }
  }
  return null;
}
