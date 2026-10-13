import test from "node:test";
import assert from "node:assert/strict";
import {
  BinaryBitmap,
  HybridBinarizer,
  QRCodeReader,
  RGBLuminanceSource,
} from "@zxing/library";
import { decodeQrLuminance, rgbaLuminance } from "../shared/qr-image.js";
import { qrRootSample } from "./fixtures.js";
import { noisyQrPixels } from "./qr-fixtures.js";

test("QR recovery reads pixel noise that defeats the original reader without changing the ticket", () => {
  const { pixels, width, height } = noisyQrPixels();
  const original = new Uint8ClampedArray(pixels);
  assert.throws(() =>
    new QRCodeReader().decode(
      new BinaryBitmap(
        new HybridBinarizer(new RGBLuminanceSource(pixels, width, height)),
      ),
    ),
  );
  assert.equal(
    decodeQrLuminance(pixels, width, height)?.getText(),
    qrRootSample,
  );
  assert.deepEqual(pixels, original);
  const inverted = pixels.map((value) => 255 - value);
  assert.equal(
    decodeQrLuminance(inverted, width, height)?.getText(),
    qrRootSample,
  );
});

test("QR recovery rejects a blank image and treats transparent pixels as white", () => {
  const width = 200,
    height = 200;
  for (const value of [0, 127, 255]) {
    assert.equal(
      decodeQrLuminance(
        new Uint8ClampedArray(width * height).fill(value),
        width,
        height,
      ),
      null,
    );
  }
  assert.deepEqual(
    rgbaLuminance(
      new Uint8ClampedArray([0, 0, 0, 0, 0, 0, 0, 255, 255, 255, 255, 255]),
    ),
    new Uint8ClampedArray([255, 0, 255]),
  );
});
