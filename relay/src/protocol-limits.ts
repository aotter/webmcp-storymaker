// A standalone mirror copy of the constants -- see the "boundary decision on file location" note
// in ../../src/preview/protocol.ts's header: relay only does a type-only import of that file, so
// the values (const) can't cross over, and this file redeclares an identical set of numbers here.
// **Whenever either side changes, be sure to check the other side too** -- both headers carry a
// comment pointing back at the other, to make them easy to find later. Whether this mirror actually
// stays in sync with the original isn't left to eyeballing alone: ../test/protocol-parity.test.ts
// value-imports both sides and expects them equal one by one.
//
// This mirror deliberately doesn't re-explain the reasoning for each constant one by one (that
// reasoning is already fully written out in protocol.ts's header) -- it only marks here which
// constant each one mirrors.

/** The size cap for a single image (raw bytes, before base64 encoding). Mirrors protocol.ts's
 * MAX_IMAGE_BYTES (= min(5 MiB, snapshot.ts's PREVIEW_LIMITS.maxImageBytes) -- currently the two
 * are equal, both 5 MiB). */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
/** Mirrors protocol.ts's MAX_SNAPSHOT_TOTAL_BYTES (currently = 20 MiB). */
export const MAX_SNAPSHOT_TOTAL_BYTES = 20 * 1024 * 1024;
/** Mirrors protocol.ts's MAX_CHUNK_BYTES. */
export const MAX_CHUNK_BYTES = 32 * 1024;
/** Mirrors protocol.ts's MAX_CHUNK_BASE64_LENGTH. */
export const MAX_CHUNK_BASE64_LENGTH = Math.ceil(MAX_CHUNK_BYTES / 3) * 4;
/** Mirrors protocol.ts's MAX_MANIFEST_JSON_BYTES. */
export const MAX_MANIFEST_JSON_BYTES = 256 * 1024;
/** Mirrors protocol.ts's RATE_LIMIT_MAX_MESSAGES / RATE_LIMIT_WINDOW_MS -- this is the rate cap
 * "per connection", not one counter shared by the whole session, see session-do.ts's header. */
export const RATE_LIMIT_MAX_MESSAGES = 200;
export const RATE_LIMIT_WINDOW_MS = 10_000;

/** Mirrors protocol.ts's PAIRING_TTL_MS / IDLE_TTL_MS / ABSOLUTE_TTL_MS. */
export const PAIRING_TTL_MS = 5 * 60_000;
export const IDLE_TTL_MS = 10 * 60_000;
export const ABSOLUTE_TTL_MS = 60 * 60_000;
/** Mirrors protocol.ts's PRE_AUTH_TIMEOUT_MS -- the maximum time a connection can stay alive before
 * sending a valid hello. */
export const PRE_AUTH_TIMEOUT_MS = 10_000;

/** Mirrors protocol.ts's MAX_IMAGE_ID_LENGTH. */
export const MAX_IMAGE_ID_LENGTH = 128;

/** Mirrors protocol.ts's HOST_KEY_PATTERN / VIEWER_TOKEN_PATTERN / SID_PATTERN -- hash-chain
 * credentials, verified against an exact length rather than just a cap. */
export const HOST_KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/;
export const VIEWER_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
export const SID_PATTERN = /^[0-9a-f]{64}$/;

/** Mirrors protocol.ts's PREVIEW_ERROR_CODES -- protocol-parity.test.ts checks one by one that both
 * sides enumerate the same set of codes. */
export const PREVIEW_ERROR_CODES = [
  "invalid-token",
  "token-consumed",
  "not-paired",
  "host-offline",
  "session-expired",
  "too-large",
  "protocol-violation",
  "rate-limited",
] as const;

/** Mirrors protocol.ts's PREVIEW_ERROR_CLOSE_CODE. Uses satisfies to build an independent
 * Record<PreviewErrorCode, number> -- the type still borrows protocol.ts's PreviewErrorCode as a
 * type-only import, so this mirror is guaranteed to enumerate exactly the same set of codes,
 * neither more nor fewer. */
import type { PreviewErrorCode } from "../../src/preview/protocol.ts";

export const ERROR_CLOSE_CODE: Record<PreviewErrorCode, number> = {
  "host-offline": 4001,
  "session-expired": 4002,
  "protocol-violation": 4003,
  "invalid-token": 4004,
  "token-consumed": 4005,
  "not-paired": 4006,
  "too-large": 4007,
  "rate-limited": 4008,
};
