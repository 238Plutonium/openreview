import { decode as decodeJpeg, encode as encodeJpeg } from "jpeg-js";

export type ScreenShareGrid = {
  width: number;
  height: number;
  pixels: Uint8Array;
};

export type ScreenShareFingerprint = {
  full: ScreenShareGrid;
  content: ScreenShareGrid;
};

export type ScreenShareDiff = {
  fullMeanAbs: number;
  contentMeanAbs: number;
  contentChangedFrac: number;
  score: number;
};

const FULL_GRID_WIDTH = 32;
const FULL_GRID_HEIGHT = 18;
const CONTENT_GRID_WIDTH = 64;
const CONTENT_GRID_HEIGHT = 36;
const CONTENT_CELL_CHANGE = 20;

const CONTENT_CROP = {
  left: 0.2,
  top: 0.16,
  right: 0.96,
  bottom: 0.9,
} as const;

export const DEFAULT_CONTENT_MEAN_ABS = 0.008;
export const DEFAULT_CONTENT_CHANGED_FRAC = 0.02;

export function cropScreenShareJpegToContent(frame: Buffer, quality = 80): Buffer {
  const decoded = decodeJpeg(frame, { useTArray: true });
  const x0 = Math.floor(decoded.width * CONTENT_CROP.left);
  const y0 = Math.floor(decoded.height * CONTENT_CROP.top);
  const x1 = Math.max(x0 + 8, Math.floor(decoded.width * CONTENT_CROP.right));
  const y1 = Math.max(y0 + 8, Math.floor(decoded.height * CONTENT_CROP.bottom));
  const cropWidth = x1 - x0;
  const cropHeight = y1 - y0;
  const pixels = new Uint8Array(cropWidth * cropHeight * 4);
  for (let y = 0; y < cropHeight; y += 1) {
    const sourceOffset = ((y0 + y) * decoded.width + x0) * 4;
    pixels.set(
      decoded.data.subarray(sourceOffset, sourceOffset + cropWidth * 4),
      y * cropWidth * 4,
    );
  }
  const encoded = encodeJpeg(
    { data: pixels, width: cropWidth, height: cropHeight },
    quality,
  );
  return Buffer.from(encoded.data);
}

export function screenShareFingerprintFromJpeg(frame: Buffer): ScreenShareFingerprint {
  const decoded = decodeJpeg(frame, { useTArray: true });
  return screenShareFingerprintFromRgba(
    decoded.data,
    decoded.width,
    decoded.height,
  );
}

export function screenShareFingerprintFromRgba(
  data: Uint8Array,
  width: number,
  height: number,
): ScreenShareFingerprint {
  const full = sampleGrid(data, width, height, 0, 0, width, height, FULL_GRID_WIDTH, FULL_GRID_HEIGHT);
  const x0 = Math.floor(width * CONTENT_CROP.left);
  const y0 = Math.floor(height * CONTENT_CROP.top);
  const x1 = Math.max(x0 + 8, Math.floor(width * CONTENT_CROP.right));
  const y1 = Math.max(y0 + 8, Math.floor(height * CONTENT_CROP.bottom));
  const content = sampleGrid(
    data,
    width,
    height,
    x0,
    y0,
    x1,
    y1,
    CONTENT_GRID_WIDTH,
    CONTENT_GRID_HEIGHT,
  );
  return { full, content };
}

export function screenShareFingerprintDiff(
  left: ScreenShareFingerprint,
  right: ScreenShareFingerprint,
): ScreenShareDiff {
  const fullMeanAbs = gridMeanAbs(left.full, right.full);
  const content = gridStats(left.content, right.content);
  return {
    fullMeanAbs,
    contentMeanAbs: content.meanAbs,
    contentChangedFrac: content.changedFrac,
    score: Math.max(fullMeanAbs, content.meanAbs, content.changedFrac),
  };
}

export function isUniqueScreenShare(
  previous: ScreenShareFingerprint | null,
  next: ScreenShareFingerprint,
  fullThreshold: number,
  contentMeanAbs = DEFAULT_CONTENT_MEAN_ABS,
  contentChangedFrac = DEFAULT_CONTENT_CHANGED_FRAC,
): { unique: boolean; diff: ScreenShareDiff | null } {
  if (!previous) {
    return { unique: true, diff: null };
  }
  const diff = screenShareFingerprintDiff(previous, next);
  const unique =
    diff.contentMeanAbs >= contentMeanAbs ||
    diff.contentChangedFrac >= contentChangedFrac ||
    diff.fullMeanAbs >= fullThreshold;
  return { unique, diff };
}

function sampleGrid(
  data: Uint8Array,
  width: number,
  height: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  targetWidth: number,
  targetHeight: number,
): ScreenShareGrid {
  const regionWidth = Math.max(1, x1 - x0);
  const regionHeight = Math.max(1, y1 - y0);
  const pixels = new Uint8Array(targetWidth * targetHeight);
  for (let y = 0; y < targetHeight; y += 1) {
    const sourceY = Math.min(
      height - 1,
      y0 + Math.floor((y / targetHeight) * regionHeight),
    );
    for (let x = 0; x < targetWidth; x += 1) {
      const sourceX = Math.min(
        width - 1,
        x0 + Math.floor((x / targetWidth) * regionWidth),
      );
      const sourceOffset = (sourceY * width + sourceX) * 4;
      const red = data[sourceOffset] ?? 0;
      const green = data[sourceOffset + 1] ?? 0;
      const blue = data[sourceOffset + 2] ?? 0;
      pixels[y * targetWidth + x] = Math.round(red * 0.299 + green * 0.587 + blue * 0.114);
    }
  }
  return { width: targetWidth, height: targetHeight, pixels };
}

function gridMeanAbs(left: ScreenShareGrid, right: ScreenShareGrid): number {
  return gridStats(left, right).meanAbs;
}

function gridStats(
  left: ScreenShareGrid,
  right: ScreenShareGrid,
): { meanAbs: number; changedFrac: number } {
  if (left.width !== right.width || left.height !== right.height) {
    return { meanAbs: 1, changedFrac: 1 };
  }
  let abs = 0;
  let changed = 0;
  const count = left.pixels.length;
  for (let index = 0; index < count; index += 1) {
    const delta = Math.abs((left.pixels[index] ?? 0) - (right.pixels[index] ?? 0));
    abs += delta;
    if (delta >= CONTENT_CELL_CHANGE) {
      changed += 1;
    }
  }
  return {
    meanAbs: abs / (count * 255),
    changedFrac: changed / count,
  };
}
