// Deterministic validation tests for ./fileValidation.ts -- the same
// (filename, bytes) input always produces the same output. This file covers
// four check surfaces: the extension allowlist, magic-bytes alignment, the
// size limit, and contentHash computation, plus the target case of
// "extension is legal but the content is disguised as another format".
//
// Scope cut: this repo takes images only (png/jpg/jpeg/webp) -- there's no
// "mp3", "m4a", "wav" validation branch; a single .mp3 case is kept as the
// scope proof: images only, no audio.
//
// Also covered: when `crypto.subtle` is absent
// or throws, this returns "unavailable", not "invalid".
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_BLOB_FILE_BYTES } from "../workspace/limits.ts";
import { isAllowedImageExt, validateImageFile } from "./fileValidation.ts";

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG_SIGNATURE = [0xff, 0xd8, 0xff];

function bytesOf(...groups: (number[] | number)[]): Uint8Array {
  const flat: number[] = [];
  for (const g of groups) {
    if (Array.isArray(g)) flat.push(...g);
    else flat.push(g);
  }
  return new Uint8Array(flat);
}

function asciiBytes(text: string): number[] {
  return [...text].map((ch) => ch.charCodeAt(0));
}

function fillerBytes(n: number): number[] {
  return new Array(n).fill(0xab);
}

describe("isAllowedImageExt", () => {
  it("accepts exactly the four whitelisted (image-only) extensions", () => {
    for (const ext of ["png", "jpg", "jpeg", "webp"]) {
      expect(isAllowedImageExt(ext)).toBe(true);
    }
  });

  it("rejects unknown extensions, including audio (out of scope: images only)", () => {
    for (const ext of ["gif", "bmp", "PNG", "svg", "mp3", "m4a", "wav", ""]) {
      expect(isAllowedImageExt(ext)).toBe(false);
    }
  });
});

describe("validateImageFile", () => {
  it("accepts a well-formed PNG and returns ext + a stable SHA-256 contentHash", async () => {
    const bytes = bytesOf(PNG_SIGNATURE, fillerBytes(16));
    const result = await validateImageFile({ filename: "cover.png", bytes });
    expect(result.status).toBe("valid");
    if (result.status !== "valid") return;
    expect(result.ext).toBe("png");
    expect(result.contentHash).toMatch(/^[0-9a-f]{64}$/);

    // Compute the same bytes again -- contentHash must be exactly identical
    // (deterministic, not random/time-related).
    const again = await validateImageFile({ filename: "cover.png", bytes });
    expect(again.status === "valid" ? again.contentHash : null).toBe(result.contentHash);
  });

  it("accepts .jpg and .jpeg for the same JPEG SOI signature", async () => {
    const bytes = bytesOf(JPEG_SIGNATURE, fillerBytes(16));
    for (const filename of ["photo.jpg", "photo.jpeg"]) {
      const result = await validateImageFile({ filename, bytes });
      expect(result.status).toBe("valid");
    }
  });

  it("accepts .webp (RIFF....WEBP) and rejects a RIFF container that isn't actually WEBP", async () => {
    const webp = bytesOf(asciiBytes("RIFF"), [0, 0, 0, 0], asciiBytes("WEBP"), fillerBytes(8));
    const notWebp = bytesOf(asciiBytes("RIFF"), [0, 0, 0, 0], asciiBytes("AVI "), fillerBytes(8));
    expect((await validateImageFile({ filename: "a.webp", bytes: webp })).status).toBe("valid");
    expect((await validateImageFile({ filename: "a.webp", bytes: notWebp })).status).toBe("invalid");
  });

  it("treats .mp3 as an unsupported extension — scope proof: images only, no audio", async () => {
    const result = await validateImageFile({ filename: "voice.mp3", bytes: bytesOf(asciiBytes("ID3"), fillerBytes(16)) });
    expect(result).toEqual({ status: "invalid", reason: expect.stringContaining("unsupported extension") });
  });

  it("rejects an unsupported extension outright, before touching bytes", async () => {
    const result = await validateImageFile({ filename: "cover.gif", bytes: bytesOf(fillerBytes(8)) });
    expect(result).toEqual({ status: "invalid", reason: expect.stringContaining("unsupported extension") });
  });

  it("rejects a filename with no usable extension", async () => {
    for (const filename of ["noext", ".png", "trailing."]) {
      const result = await validateImageFile({ filename, bytes: bytesOf(PNG_SIGNATURE) });
      expect(result.status).toBe("invalid");
    }
  });

  it("rejects empty content", async () => {
    const result = await validateImageFile({ filename: "cover.png", bytes: new Uint8Array(0) });
    expect(result).toEqual({ status: "invalid", reason: "file content is empty" });
  });

  it("rejects content over MAX_BLOB_FILE_BYTES", async () => {
    // Write directly with Uint8Array.set() instead of going through
    // bytesOf()/array spread -- spreading a plain array 50 million entries
    // long into push(...) pays far more call-stack/memory cost than needed;
    // all we need here is a giant Uint8Array "one byte over the limit",
    // without needing to build up any meaningful content.
    const oversized = new Uint8Array(MAX_BLOB_FILE_BYTES + 1);
    oversized.set(PNG_SIGNATURE, 0);
    const result = await validateImageFile({ filename: "cover.png", bytes: oversized });
    expect(result.status).toBe("invalid");
    if (result.status === "invalid") expect(result.reason).toContain("exceeds the per-file limit");
  });

  it("rejects a file whose extension is legal but whose magic bytes don't match (renamed/disguised file)", async () => {
    // A real JPEG, but the filename claims .png -- the extension itself is
    // in the allowlist, so magic bytes must be the thing that blocks it.
    const jpegBytesNamedPng = bytesOf(JPEG_SIGNATURE, fillerBytes(16));
    const result = await validateImageFile({ filename: "cover.png", bytes: jpegBytesNamedPng });
    expect(result.status).toBe("invalid");
    if (result.status === "invalid") expect(result.reason).toContain("magic bytes");
  });

  it("rejects truncated content too short to carry a valid signature", async () => {
    const tooShort = new Uint8Array([0x89, 0x50]); // only the first two bytes of the PNG signature
    const result = await validateImageFile({ filename: "cover.png", bytes: tooShort });
    expect(result.status).toBe("invalid");
  });
});

describe("validateImageFile — crypto.subtle unavailable returns 'unavailable' (not 'invalid')", () => {
  const originalCrypto = globalThis.crypto;

  afterEach(() => {
    Object.defineProperty(globalThis, "crypto", { value: originalCrypto, configurable: true, writable: true });
    vi.restoreAllMocks();
  });

  it("returns unavailable, not invalid, when crypto.subtle is absent (a common case on non-secure contexts)", async () => {
    Object.defineProperty(globalThis, "crypto", { value: { ...originalCrypto, subtle: undefined }, configurable: true, writable: true });

    const bytes = bytesOf(PNG_SIGNATURE, fillerBytes(16));
    const result = await validateImageFile({ filename: "cover.png", bytes });
    expect(result.status).toBe("unavailable");
    if (result.status === "unavailable") expect(result.reason).toContain("https or localhost");
  });

  it("also returns unavailable when crypto.subtle.digest() itself throws", async () => {
    vi.spyOn(globalThis.crypto.subtle, "digest").mockRejectedValue(new Error("boom"));

    const bytes = bytesOf(PNG_SIGNATURE, fillerBytes(16));
    const result = await validateImageFile({ filename: "cover.png", bytes });
    expect(result.status).toBe("unavailable");
  });
});
