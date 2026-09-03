// Compares
// whether two list() snapshots represent the same workspace version -- used to detect
// whether one logical read that spans multiple storage calls (list/readFile happening
// separately) got changed midway by a concurrent mutate().
//
// ../story/readStory.ts ran into a "torn read"
// problem (story.yaml's readFile() sandwiched between two list() calls can have a concurrent
// mutate() slip in between, reading a combination of "old spec + new revision" that never
// actually existed), so this comparison was extracted into this shared small utility -- the same piece of
// logic should have exactly one authority, not a second rewritten copy -- see the note below for its current callers.
import type { WorkspaceSnapshot } from "./types.ts";

/** The optimistic-retry cap for one "read spanning multiple storage calls" -- reading
 * story.yaml, readiness, and set_page_image all use this number
 * (see each caller file's empirical observations about this number). */
export const CONSISTENT_READ_MAX_ATTEMPTS = 3;

/** Whether two WorkspaceSnapshots represent the same workspace version: same revision, and
 * the entries list (path/kind/byteLength, compared item by item, same length) is identical.
 * Does not compare file contents themselves -- list() never returns content in the first
 * place; this only answers "between these two list() calls, was the workspace touched by any
 * mutate()?" */
export function snapshotsMatch(a: WorkspaceSnapshot, b: WorkspaceSnapshot): boolean {
  if (a.revision !== b.revision) return false;
  if (a.entries.length !== b.entries.length) return false;
  for (let i = 0; i < a.entries.length; i++) {
    const x = a.entries[i];
    const y = b.entries[i];
    if (x.path !== y.path || x.kind !== y.kind || x.byteLength !== y.byteLength) return false;
  }
  return true;
}

/** A general-purpose skeleton for "one logical read across multiple
 * files, treated as one workspace version" -- extracts the optimistic-retry pattern
 * ../story/readStory.ts already hand-rolled ("compare snapshots before/after list(), redo
 * the whole round if they don't match") into a reusable version, for new callers to use
 * (../story/readiness.ts: needs to read media.json/the file list beyond story.yaml in one
 * go to report media/content completeness; ../media/setPageImage.ts likewise) instead of
 * each hand-rolling its own for-loop.
 *
 * Deliberately not rewriting readStory.ts to use this instead -- readStory.ts's existing
 * behavior is left untouched; this adds a new utility for new callers to
 * use, without touching the old caller's existing code, even though the loop skeleton looks
 * duplicated. */
export interface ConsistentMultiReadResult<T> {
  readonly ok: true;
  /** The workspace snapshot this read round converged on, corresponding to `value`. */
  readonly snapshot: WorkspaceSnapshot;
  readonly value: T;
}

export interface ConsistentMultiReadFailure {
  readonly ok: false;
}

/**
 * `read(before)` is what this logical-read round actually does (it may call any number of
 * `storage.readFile()` calls or other pure computation) -- `before` is the snapshot taken
 * before this read round started, letting `read` decide "should I read this file" (e.g. only
 * readFile if the file exists, skip otherwise) without having to call `list()` again itself.
 * After `read` finishes, `list()` is called once more; only if the two snapshots (entries +
 * revision) are identical does that mean the content `read` saw actually corresponds to the
 * same workspace version -- otherwise the whole round is discarded and retried. The retry
 * cap follows `CONSISTENT_READ_MAX_ATTEMPTS`; once exhausted without reaching a consistent
 * snapshot, it returns `{ ok: false }`, and it's up to the caller to decide what error
 * semantics to wrap that in (different callers' error shapes aren't necessarily the same,
 * and this function doesn't decide that on the caller's behalf).
 *
 * Any exception `read` throws internally propagates outward unchanged -- this function is
 * only responsible for "was the read torn," not for `read`'s own logic errors.
 */
export async function readConsistentSnapshot<T>(
  storage: { list(): Promise<WorkspaceSnapshot> },
  read: (before: WorkspaceSnapshot) => Promise<T>,
): Promise<ConsistentMultiReadResult<T> | ConsistentMultiReadFailure> {
  for (let attempt = 1; attempt <= CONSISTENT_READ_MAX_ATTEMPTS; attempt++) {
    const before = await storage.list();
    const value = await read(before);
    const after = await storage.list();
    if (snapshotsMatch(before, after)) {
      return { ok: true, snapshot: after, value };
    }
  }
  return { ok: false };
}
