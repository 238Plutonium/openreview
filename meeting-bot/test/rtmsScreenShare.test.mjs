import assert from "node:assert/strict";
import test from "node:test";
import { encode as encodeJpeg } from "jpeg-js";
import {
  cropScreenShareJpegToContent,
  isUniqueScreenShare,
  screenShareFingerprintFromJpeg,
  screenShareFingerprintFromRgba,
  screenShareFingerprintDiff,
} from "../dist/screenShareFingerprint.js";

const WIDTH = 1920;
const HEIGHT = 1080;

function createRgba() {
  return new Uint8Array(WIDTH * HEIGHT * 4);
}

function fillRect(data, x0, y0, x1, y1, r, g, b) {
  const left = Math.max(0, Math.floor(x0));
  const top = Math.max(0, Math.floor(y0));
  const right = Math.min(WIDTH, Math.ceil(x1));
  const bottom = Math.min(HEIGHT, Math.ceil(y1));
  for (let y = top; y < bottom; y += 1) {
    for (let x = left; x < right; x += 1) {
      const offset = (y * WIDTH + x) * 4;
      data[offset] = r;
      data[offset + 1] = g;
      data[offset + 2] = b;
      data[offset + 3] = 255;
    }
  }
}

function drawBrowserChrome(data, { thumbHighlightX = 240 } = {}) {
  fillRect(data, 0, 0, WIDTH, HEIGHT, 28, 30, 34);
  fillRect(data, 0, 0, Math.floor(WIDTH * 0.18), HEIGHT, 22, 22, 26);
  fillRect(data, 0, 0, WIDTH, Math.floor(HEIGHT * 0.12), 40, 42, 48);
  fillRect(data, 0, Math.floor(HEIGHT * 0.9), WIDTH, HEIGHT, 36, 38, 44);
  fillRect(
    data,
    thumbHighlightX,
    Math.floor(HEIGHT * 0.915),
    thumbHighlightX + 90,
    Math.floor(HEIGHT * 0.985),
    90,
    140,
    220,
  );
}

function drawWhiteSlide(data) {
  fillRect(
    data,
    Math.floor(WIDTH * 0.2),
    Math.floor(HEIGHT * 0.16),
    Math.floor(WIDTH * 0.96),
    Math.floor(HEIGHT * 0.9),
    250,
    250,
    252,
  );
}

function drawHeadingBars(data, bars) {
  for (const [x0, y0, x1, y1] of bars) {
    fillRect(data, x0, y0, x1, y1, 18, 18, 18);
  }
}

function titleSlide(thumbHighlightX) {
  const data = createRgba();
  drawBrowserChrome(data, { thumbHighlightX });
  drawWhiteSlide(data);
  drawHeadingBars(data, [
    [520, 250, 1480, 262],
    [640, 280, 1280, 290],
  ]);
  return data;
}

function disclosuresSlide(thumbHighlightX) {
  const data = createRgba();
  drawBrowserChrome(data, { thumbHighlightX });
  drawWhiteSlide(data);
  drawHeadingBars(data, [
    [520, 250, 1480, 262],
    [640, 280, 1280, 290],
    [500, 328, 1500, 336],
    [500, 390, 1460, 398],
    [500, 439, 1400, 447],
  ]);
  return data;
}

function oldFullFrameMeanAbs(left, right) {
  const targetWidth = 32;
  const targetHeight = 18;
  const sample = (data) => {
    const pixels = new Uint8Array(targetWidth * targetHeight);
    for (let y = 0; y < targetHeight; y += 1) {
      const sourceY = Math.min(HEIGHT - 1, Math.floor((y / targetHeight) * HEIGHT));
      for (let x = 0; x < targetWidth; x += 1) {
        const sourceX = Math.min(WIDTH - 1, Math.floor((x / targetWidth) * WIDTH));
        const offset = (sourceY * WIDTH + sourceX) * 4;
        pixels[y * targetWidth + x] = Math.round(
          (data[offset] ?? 0) * 0.299 +
            (data[offset + 1] ?? 0) * 0.587 +
            (data[offset + 2] ?? 0) * 0.114,
        );
      }
    }
    return pixels;
  };
  const a = sample(left);
  const b = sample(right);
  let abs = 0;
  for (let index = 0; index < a.length; index += 1) {
    abs += Math.abs((a[index] ?? 0) - (b[index] ?? 0));
  }
  return abs / (a.length * 255);
}

test("identical frames are duplicates", () => {
  const frame = titleSlide(240);
  const previous = screenShareFingerprintFromRgba(frame, WIDTH, HEIGHT);
  const next = screenShareFingerprintFromRgba(frame, WIDTH, HEIGHT);
  const decision = isUniqueScreenShare(previous, next, 0.035);
  assert.equal(decision.unique, false);
  assert.equal(decision.diff?.score, 0);
});

test("first screen-share frame is unique", () => {
  const next = screenShareFingerprintFromRgba(titleSlide(240), WIDTH, HEIGHT);
  const decision = isUniqueScreenShare(null, next, 0.035);
  assert.equal(decision.unique, true);
  assert.equal(decision.diff, null);
});

test("title vs disclosures body text is unique even when the old full-frame score is low", () => {
  const title = titleSlide(240);
  const disclosures = disclosuresSlide(240);
  const oldScore = oldFullFrameMeanAbs(title, disclosures);
  assert.ok(oldScore < 0.035, `old detector would have dropped this slide change: ${oldScore}`);

  const previous = screenShareFingerprintFromRgba(title, WIDTH, HEIGHT);
  const next = screenShareFingerprintFromRgba(disclosures, WIDTH, HEIGHT);
  const diff = screenShareFingerprintDiff(previous, next);
  const decision = isUniqueScreenShare(previous, next, 0.035);
  assert.equal(decision.unique, true);
  assert.ok(diff.contentMeanAbs >= 0.008 || diff.contentChangedFrac >= 0.02);
});

test("thumbnail-strip highlight movement is treated as a duplicate", () => {
  const first = titleSlide(220);
  const second = titleSlide(820);
  const previous = screenShareFingerprintFromRgba(first, WIDTH, HEIGHT);
  const next = screenShareFingerprintFromRgba(second, WIDTH, HEIGHT);
  const decision = isUniqueScreenShare(previous, next, 0.035);
  assert.equal(decision.unique, false);
  assert.ok((decision.diff?.contentChangedFrac ?? 1) < 0.02);
});

test("JPEG title vs disclosures still counts as unique", () => {
  const titleJpeg = Buffer.from(
    encodeJpeg({ data: titleSlide(240), width: WIDTH, height: HEIGHT }, 80).data,
  );
  const disclosuresJpeg = Buffer.from(
    encodeJpeg({ data: disclosuresSlide(240), width: WIDTH, height: HEIGHT }, 80).data,
  );
  const previous = screenShareFingerprintFromJpeg(titleJpeg);
  const next = screenShareFingerprintFromJpeg(disclosuresJpeg);
  const decision = isUniqueScreenShare(previous, next, 0.035);
  assert.equal(decision.unique, true);
});

test("crops typical PowerPoint Online chrome off a screen-share JPEG", () => {
  const jpeg = Buffer.from(
    encodeJpeg({ data: titleSlide(240), width: WIDTH, height: HEIGHT }, 80).data,
  );
  const cropped = cropScreenShareJpegToContent(jpeg);
  assert.ok(cropped.length > 0);
  assert.ok(cropped.length < jpeg.length);
});
