// relay/src/protocol-limits.ts is a standalone mirror copy of the constants in
// ../../src/preview/protocol.ts (see the "boundary decision on file location" note in both file
// headers -- relay can only type-only import protocol.ts, so the values can't cross over, hence a
// manually copied duplicate). Something manually copied is bound to drift sooner or later without a
// test -- this test does a **value** import of both sides (not type-only), and expects them equal
// one by one, so if either side's numbers change and the other side isn't updated to match, this
// fails immediately.
//
// This is the only test in this repo that value-imports both protocol.ts and the relay's own code
// -- deliberately: its whole reason for existing is to compare the two sides, not to demonstrate
// that "relay source can import the protocol file directly" (relay/src/** still always uses
// type-only imports, see each file's header).
import { describe, expect, it } from "vitest";
import * as protocol from "../../src/preview/protocol.ts";
import * as relayLimits from "./../src/protocol-limits.ts";

describe("protocol.ts <-> relay/src/protocol-limits.ts constant parity", () => {
  it("size caps match", () => {
    expect(relayLimits.MAX_IMAGE_BYTES).toBe(protocol.MAX_IMAGE_BYTES);
    expect(relayLimits.MAX_SNAPSHOT_TOTAL_BYTES).toBe(protocol.MAX_SNAPSHOT_TOTAL_BYTES);
    expect(relayLimits.MAX_CHUNK_BYTES).toBe(protocol.MAX_CHUNK_BYTES);
    expect(relayLimits.MAX_CHUNK_BASE64_LENGTH).toBe(protocol.MAX_CHUNK_BASE64_LENGTH);
    expect(relayLimits.MAX_MANIFEST_JSON_BYTES).toBe(protocol.MAX_MANIFEST_JSON_BYTES);
    expect(relayLimits.MAX_IMAGE_ID_LENGTH).toBe(protocol.MAX_IMAGE_ID_LENGTH);
  });

  it("rate limit matches", () => {
    expect(relayLimits.RATE_LIMIT_MAX_MESSAGES).toBe(protocol.RATE_LIMIT_MAX_MESSAGES);
    expect(relayLimits.RATE_LIMIT_WINDOW_MS).toBe(protocol.RATE_LIMIT_WINDOW_MS);
  });

  it("TTLs and the pre-auth timeout match", () => {
    expect(relayLimits.PAIRING_TTL_MS).toBe(protocol.PAIRING_TTL_MS);
    expect(relayLimits.IDLE_TTL_MS).toBe(protocol.IDLE_TTL_MS);
    expect(relayLimits.ABSOLUTE_TTL_MS).toBe(protocol.ABSOLUTE_TTL_MS);
    expect(relayLimits.PRE_AUTH_TIMEOUT_MS).toBe(protocol.PRE_AUTH_TIMEOUT_MS);
  });

  it("credential/sid patterns match (compared by .source, since RegExp objects are never === across two literals)", () => {
    expect(relayLimits.HOST_KEY_PATTERN.source).toBe(protocol.HOST_KEY_PATTERN.source);
    expect(relayLimits.VIEWER_TOKEN_PATTERN.source).toBe(protocol.VIEWER_TOKEN_PATTERN.source);
    expect(relayLimits.SID_PATTERN.source).toBe(protocol.SID_PATTERN.source);
  });

  it("PREVIEW_ERROR_CODES enumerates exactly the same codes, in the same order", () => {
    expect(relayLimits.PREVIEW_ERROR_CODES).toEqual(protocol.PREVIEW_ERROR_CODES);
  });

  it("the error-code -> close-code table matches exactly", () => {
    expect(relayLimits.ERROR_CLOSE_CODE).toEqual(protocol.PREVIEW_ERROR_CLOSE_CODE);
  });

  it("every PreviewErrorCode has exactly one entry in both close-code tables (no drift in either direction)", () => {
    const protocolKeys = Object.keys(protocol.PREVIEW_ERROR_CLOSE_CODE).sort();
    const relayKeys = Object.keys(relayLimits.ERROR_CLOSE_CODE).sort();
    expect(relayKeys).toEqual(protocolKeys);
    expect(protocolKeys).toEqual([...protocol.PREVIEW_ERROR_CODES].sort());
  });
});
