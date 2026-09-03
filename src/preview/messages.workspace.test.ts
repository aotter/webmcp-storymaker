// An exhaustive test of formatPreviewSourceError() - every
// PreviewSourceError.type must have a non-empty fixed English message, and the two fixed
// strings for host-offline/expired must match exactly.
import { describe, expect, it } from "vitest";
import type { PreviewSourceError } from "./source.ts";
import { formatPreviewSourceError } from "./messages.ts";

const ALL_TYPES: readonly PreviewSourceError["type"][] = [
  "no-story",
  "invalid-story",
  "unavailable",
  "expired",
  "host-offline",
  "rejected",
];

describe("formatPreviewSourceError", () => {
  it.each(ALL_TYPES)("returns a non-empty fixed message for %s", (type) => {
    const message = formatPreviewSourceError({ type } as PreviewSourceError);
    expect(message.length).toBeGreaterThan(0);
  });

  it("host-offline is the exact required message", () => {
    expect(formatPreviewSourceError({ type: "host-offline" })).toBe("The creator went offline, so the preview ended.");
  });

  it("expired is the exact required message", () => {
    expect(formatPreviewSourceError({ type: "expired" })).toBe("The preview has expired. Please scan the code again.");
  });

  it("never reads the reason field - the message is the same for a given type regardless of reason", () => {
    const withReason = formatPreviewSourceError({ type: "invalid-story", reason: "a technical debugging string that shouldn't leak" });
    const withoutReason = formatPreviewSourceError({ type: "invalid-story" });
    expect(withReason).toBe(withoutReason);
    expect(withReason).not.toContain("a technical debugging string");
  });

  it("the six types each have distinct messages (so a reader can tell which situation happened)", () => {
    const messages = new Set(ALL_TYPES.map((type) => formatPreviewSourceError({ type } as PreviewSourceError)));
    expect(messages.size).toBe(ALL_TYPES.length);
  });
});
