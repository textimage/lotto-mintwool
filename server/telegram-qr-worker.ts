import { parentPort, workerData } from "node:worker_threads";
import sharp from "sharp";
import {
  BinaryBitmap,
  HybridBinarizer,
  GlobalHistogramBinarizer,
  RGBLuminanceSource,
  QRCodeReader,
  DecodeHintType,
} from "@zxing/library";

async function decode() {
  const bytes = Buffer.from(workerData as Uint8Array);
  const image = sharp(bytes, { limitInputPixels: 40_000_000 });
  const metadata = await image.metadata();
  if (!["jpeg", "png"].includes(metadata.format ?? ""))
    throw new Error("JPEG 또는 PNG 사진을 보내 주세요.");
  const reader = new QRCodeReader();
  const hints = new Map<DecodeHintType, unknown>([
    [DecodeHintType.TRY_HARDER, true],
  ]);
  for (const size of [3000, 1800, 1000]) {
    const { data, info } = await image
      .clone()
      .rotate()
      .flatten({ background: "#ffffff" })
      .resize({
        width: size,
        height: size,
        fit: "inside",
        withoutEnlargement: true,
      })
      .greyscale()
      .normalize()
      .raw()
      .toBuffer({ resolveWithObject: true });
    // greyscale raw output is one byte per pixel; ZXing expects luminance, not RGB bytes.
    const luminance = new Uint8ClampedArray(info.width * info.height);
    for (let i = 0; i < luminance.length; i++)
      luminance[i] = data[i * info.channels];
    const source = new RGBLuminanceSource(luminance, info.width, info.height);
    for (const candidate of [source, source.invert()]) {
      for (const Binarizer of [HybridBinarizer, GlobalHistogramBinarizer]) {
        try {
          return reader
            .decode(new BinaryBitmap(new Binarizer(candidate)), hints)
            .getText();
        } catch {
          /* try another scale / luminance */
        }
      }
    }
  }
  throw new Error(
    "QR을 읽지 못했습니다. QR 부분을 확대해서 촬영하거나 원본 사진 파일을 보내 주세요.",
  );
}

decode()
  .then((raw) => parentPort?.postMessage({ raw }))
  .catch((error) => {
    const known =
      error instanceof Error &&
      [
        "JPEG 또는 PNG 사진을 보내 주세요.",
        "QR을 읽지 못했습니다. QR 부분을 확대해서 촬영하거나 원본 사진 파일을 보내 주세요.",
      ].includes(error.message);
    parentPort?.postMessage({
      error: known
        ? error.message
        : "사진을 처리하지 못했습니다. 4천만 픽셀 이하의 JPEG·PNG 사진을 다시 보내 주세요.",
    });
  });
