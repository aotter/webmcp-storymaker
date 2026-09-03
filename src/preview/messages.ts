// PreviewSourceError -> a fixed, parent/reader-readable English
// message.
//
// A pure function, zero DOM - ./reader.ts is the only caller. Follows the existing discipline
// from ../ui/messages.ts: enumerated as Record<PreviewSourceError["type"], string>, not a
// switch - the benefit is the same as explained in that file's header: if ./source.ts adds a
// new error type and this file forgets to add a matching message, it becomes a typecheck
// failure right away (a missing key in the Record), not a silent omission.
//
// Each type has exactly one fixed message, and never reads error.reason (that field is for
// logging/debugging only, see the PreviewSourceError header in ./source.ts) - the message the
// reader shows to the reader/creator is always one of the messages here, and the wording never
// varies with underlying error detail, so a parent can reliably recognize "which situation
// happened."
import type { PreviewSourceError } from "./source.ts";

const PREVIEW_SOURCE_ERROR_MESSAGE: Record<PreviewSourceError["type"], string> = {
  "no-story": "There isn't a story to preview on this device yet.",
  "invalid-story": "This story can't be previewed yet - fix its structure or content first.",
  unavailable: "The preview isn't available right now. Please try again in a moment.",
  expired: "The preview has expired. Please scan the code again.",
  "host-offline": "The creator went offline, so the preview ended.",
  rejected: "The creator declined this preview.",
  "no-token": "Open this page using the QR code on the creator's screen.",
};

export function formatPreviewSourceError(error: PreviewSourceError): string {
  return PREVIEW_SOURCE_ERROR_MESSAGE[error.type];
}
