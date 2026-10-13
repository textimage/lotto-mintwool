import assert from "node:assert/strict";
import sharp from "sharp";
import { BarcodeFormat, QRCodeWriter } from "@zxing/library";
import { QrDecoder } from "../server/telegram-qr.js";

// Run inside the deployed container too: exercises its native sharp binary and compiled worker.
const raw = "1245m010203040506m0102030405060000000011.net";
const matrix = new QRCodeWriter().encode(
  raw,
  BarcodeFormat.QR_CODE,
  500,
  500,
  new Map(),
);
const pixels = Buffer.alloc(matrix.getWidth() * matrix.getHeight(), 255);
for (let y = 0; y < matrix.getHeight(); y++)
  for (let x = 0; x < matrix.getWidth(); x++)
    if (matrix.get(x, y)) pixels[y * matrix.getWidth() + x] = 0;
const png = await sharp(pixels, {
  raw: { width: matrix.getWidth(), height: matrix.getHeight(), channels: 1 },
})
  .png()
  .toBuffer();
const decoder = new QrDecoder();
try {
  assert.equal(await decoder.decode(png), raw);
  assert.equal(
    await decoder.decode(await sharp(png).rotate(90).jpeg().toBuffer()),
    raw,
  );
  console.log(
    `QR worker PNG/JPEG 확인 완료 (${process.platform}/${process.arch})`,
  );
} finally {
  await decoder.stop();
}
