// Workspace size limits -- guard against a single mutation flooding the browser tab's memory
// with reasonable limits for a single file and a single mutation. There's no official
// baseline to consult; the numbers below are judgment calls,
// with the reasoning in each constant's comment.

/** Limit for a single text file (YAML/JSON/fragment plaintext). The content is inherently
 * hand-written YAML/JSON/fragment plaintext, and its reasonable size is far below this --
 * 2MiB is already enough to hold any normal story's YAML, metadata, or single fragment;
 * beyond this amount, it no longer looks like hand-written content. */
export const MAX_TEXT_FILE_BYTES = 2 * 1024 * 1024; // 2 MiB

/** Limit for a single blob (media) file -- the per-file media limit; 50MiB is already a
 * fairly generous limit for a single image. */
export const MAX_BLOB_FILE_BYTES = 50 * 1024 * 1024; // 50 MiB

/** Limit on the number of ops in a single mutation batch -- prevents cramming thousands of
 * ops into one call; even if every op is individually legal, the batch's own
 * validation/application cost still needs a bound. */
export const MAX_MUTATION_OPS = 200;

/** Limit on the total byte count of a single mutation batch (summed over write ops'
 * content). The per-file media limit is 50MiB, and one mutation needs to be able to land a
 * natural batch of writes like "one illustration plus a few fragments of text" at once, but
 * it can't be unbounded: 80MiB is a bit larger than one full-size media file, enough to hold
 * one large image plus some text files; a batch beyond this amount should be split across
 * multiple mutations (e.g. import a whole chapter's illustrations in batches, rather than
 * cramming ten images into one). */
export const MAX_MUTATION_TOTAL_BYTES = 80 * 1024 * 1024; // 80 MiB
