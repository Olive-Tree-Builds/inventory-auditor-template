import { Buffer } from "node:buffer";

export const BRAND_LOGO_BUCKET = "brand-logos";
export const BRAND_LOGO_MAX_BYTES = 2 * 1024 * 1024;
export const BRAND_LOGO_REQUEST_MAX_BYTES = 2_800_000;

const MAX_DIMENSION = 4096;
const MAX_PIXELS = MAX_DIMENSION * MAX_DIMENSION;

type SupportedBrandLogo = {
  bytes: Buffer;
  contentType: "image/png" | "image/jpeg" | "image/webp";
  extension: "png" | "jpg" | "webp";
};

export class BrandLogoValidationError extends Error {
  constructor(
    message: string,
    public readonly status: 400 | 413 = 400,
    public readonly code = "invalid_brand_logo",
  ) {
    super(message);
  }
}

function invalidLogo(message = "Choose a valid PNG, JPEG, or WebP image."): never {
  throw new BrandLogoValidationError(message);
}

function assertSafeDimensions(width: number, height: number) {
  if (
    !Number.isInteger(width)
    || !Number.isInteger(height)
    || width < 1
    || height < 1
    || width > MAX_DIMENSION
    || height > MAX_DIMENSION
    || width * height > MAX_PIXELS
  ) {
    invalidLogo(`Brand logos must be no larger than ${MAX_DIMENSION} by ${MAX_DIMENSION} pixels.`);
  }
}

function inspectPng(bytes: Buffer) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (
    bytes.length < 33
    || !bytes.subarray(0, 8).equals(signature)
    || bytes.readUInt32BE(8) !== 13
    || bytes.toString("ascii", 12, 16) !== "IHDR"
    || bytes.readUInt32BE(bytes.length - 12) !== 0
    || bytes.toString("ascii", bytes.length - 8, bytes.length - 4) !== "IEND"
  ) {
    invalidLogo();
  }
  assertSafeDimensions(bytes.readUInt32BE(16), bytes.readUInt32BE(20));
}

const JPEG_START_OF_FRAME_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

function inspectJpeg(bytes: Buffer) {
  if (
    bytes.length < 12
    || bytes[0] !== 0xff
    || bytes[1] !== 0xd8
    || bytes[bytes.length - 2] !== 0xff
    || bytes[bytes.length - 1] !== 0xd9
  ) {
    invalidLogo();
  }

  let offset = 2;
  while (offset < bytes.length - 1) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length) break;
    const marker = bytes[offset];
    offset += 1;
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.length) invalidLogo();
    const segmentLength = bytes.readUInt16BE(offset);
    if (segmentLength < 2 || offset + segmentLength > bytes.length) invalidLogo();
    if (JPEG_START_OF_FRAME_MARKERS.has(marker)) {
      if (segmentLength < 7) invalidLogo();
      assertSafeDimensions(bytes.readUInt16BE(offset + 5), bytes.readUInt16BE(offset + 3));
      return;
    }
    offset += segmentLength;
  }
  invalidLogo();
}

function readUInt24LE(bytes: Buffer, offset: number) {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
}

function inspectWebp(bytes: Buffer) {
  if (
    bytes.length < 30
    || bytes.toString("ascii", 0, 4) !== "RIFF"
    || bytes.toString("ascii", 8, 12) !== "WEBP"
    || bytes.readUInt32LE(4) !== bytes.length - 8
  ) {
    invalidLogo();
  }

  const chunkType = bytes.toString("ascii", 12, 16);
  if (chunkType === "VP8X") {
    assertSafeDimensions(readUInt24LE(bytes, 24) + 1, readUInt24LE(bytes, 27) + 1);
    return;
  }
  if (chunkType === "VP8L") {
    if (bytes[20] !== 0x2f) invalidLogo();
    const width = 1 + bytes[21] + ((bytes[22] & 0x3f) << 8);
    const height = 1 + (bytes[22] >> 6) + (bytes[23] << 2) + ((bytes[24] & 0x0f) << 10);
    assertSafeDimensions(width, height);
    return;
  }
  if (chunkType === "VP8 ") {
    if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) invalidLogo();
    assertSafeDimensions(bytes.readUInt16LE(26) & 0x3fff, bytes.readUInt16LE(28) & 0x3fff);
    return;
  }
  invalidLogo();
}

export function parseBrandLogoDataUrl(dataUrl: string): SupportedBrandLogo {
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl);
  if (!match || match[2].length % 4 !== 0) invalidLogo();

  const contentType = match[1] as SupportedBrandLogo["contentType"];
  const encoded = match[2];
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.length > BRAND_LOGO_MAX_BYTES) {
    throw new BrandLogoValidationError(
      "Brand logos must be 2 MiB or smaller.",
      413,
      "brand_logo_too_large",
    );
  }
  if (bytes.length === 0 || bytes.toString("base64") !== encoded) invalidLogo();

  if (contentType === "image/png") inspectPng(bytes);
  else if (contentType === "image/jpeg") inspectJpeg(bytes);
  else inspectWebp(bytes);

  return {
    bytes,
    contentType,
    extension: contentType === "image/png" ? "png" : contentType === "image/jpeg" ? "jpg" : "webp",
  };
}
