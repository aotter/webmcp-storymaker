// The IndexedDB implementation of WorkspaceStoragePort -- unlike the memory
// version (MemoryWorkspaceStorage in ../testing/fakes.ts), this is a
// workspace storage backend that survives a reload.
// Validation/atomic planning is entirely delegated to
// ../workspace/mutate.ts's planMutation() pure function; this adapter only
// does two things: (1) feed IndexedDB's current state to planMutation for
// planning, and (2) once planning succeeds, land the corresponding
// writes/deletes + revision update into the same IndexedDB transaction.
//
// == Transaction / OCC strategy (recorded here for later readers) ==
//
// - Reading the revision and applying the writes happen inside the same
//   readwrite transaction: mutate() opens a single transaction against the
//   `files`/`meta` object stores at the start, reads the revision inside that
//   transaction (trusting no in-memory adapter cache -- this adapter never
//   caches any state to begin with), computes the planMutation result, and
//   then the write operations (store.put/store.delete) also happen inside
//   that same transaction. An IndexedDB readwrite transaction is itself
//   atomic: an abort partway through (whether we call tx.abort() ourselves,
//   or any request errors out) rolls back every write already queued in that
//   transaction, returning the object store to the state it was in before
//   the transaction started -- this is exactly where the "zero partial
//   writes" guarantee comes from, with no need for the adapter to implement
//   its own rollback.
//
// - Serializing concurrent mutate() calls: this adapter does not add its own
//   JS-side lock/queue, and instead relies on a guarantee from the IndexedDB
//   spec itself -- on the same IDBDatabase connection, readwrite
//   transactions with overlapping scope are always run in order, never
//   interleaved (per spec: transactions with overlapping scope run
//   serially). So when "two mutate() calls on the same adapter instance"
//   happen nearly simultaneously, the browser/IndexedDB engine itself
//   schedules the second transaction to start only after the first one
//   commits/aborts -- the revision read inside the second transaction is
//   guaranteed to be the result already submitted by the first, so the OCC
//   check is naturally correct, with no race where "both transactions read
//   the same stale revision". This is more reliable than wrapping our own JS
//   mutex (it won't miss a transaction issued outside this adapter
//   instance), and it's also the only scope this guarantee covers
//   (correctness within a single adapter instance; real-time coordination
//   across multiple tabs against the same IndexedDB database -- e.g. whether
//   to notify each other, whether to preempt -- is out of scope here and is
//   explicitly deferred).
//
// - state.files only needs the "set of paths", not loaded content:
//   planMutation() only uses the Map's has()/delete() to check whether
//   existing files exist, and never reads an existing file's text/bytes (see
//   ../workspace/mutate.ts). So this code only uses getAllKeys() to get the
//   current set of paths, and assembles a type-correct WorkspaceState with
//   placeholder content -- there's no need to load every blob's bytes into
//   memory just to plan one mutation, which is a necessary efficiency
//   consideration (not laziness) for a workspace that already has a large
//   number of media files. The content actually landed comes directly from
//   mutation.ops itself (not reverse-engineered from planMutation's returned
//   nextFiles) -- the two are necessarily equivalent whenever planning
//   succeeds (nextFiles is just "unchanged existing files + the result of
//   applying ops"), but writing only from ops means never rewriting any
//   unchanged existing file, so the write volume scales with the size of the
//   mutation, not with the size of the whole workspace.
import type { WorkspaceStoragePort } from "../ports.ts";
import { planMutation } from "../workspace/mutate.ts";
import type {
  WorkspaceEntry,
  WorkspaceFile,
  WorkspaceMutation,
  WorkspaceMutationResult,
  WorkspaceSnapshot,
  WorkspaceState,
} from "../workspace/types.ts";

const FILES_STORE = "files";
const META_STORE = "meta";
const REVISION_KEY = "revision";
const DB_VERSION = 1;
const DEFAULT_DB_NAME = "storymaker-workspace";

const textEncoder = new TextEncoder();

function byteLengthOf(file: WorkspaceFile): number {
  return file.kind === "text" ? textEncoder.encode(file.text).length : file.bytes.length;
}

/** Defensive copy: the blob content returned to the caller is not the same
 * Uint8Array held by the IndexedDB record itself, so a caller mutating the
 * content it read back in place can't silently corrupt the workspace state
 * already landed. */
function cloneFile(file: WorkspaceFile): WorkspaceFile {
  return file.kind === "blob" ? { kind: "blob", path: file.path, bytes: file.bytes.slice() } : file;
}

// ---- A thin IndexedDB -> Promise wrapper (no convenience library
// like idb -- a few dozen lines wrapping the native API is enough) ----

function idbRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

function idbTransactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed"));
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction was aborted"));
  });
}

function idbOpenDatabase(factory: IDBFactory, name: string, version: number): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(name, version);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(FILES_STORE)) {
        db.createObjectStore(FILES_STORE, { keyPath: "path" });
      }
      if (!db.objectStoreNames.contains(META_STORE)) {
        db.createObjectStore(META_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed"));
    request.onblocked = () => reject(new Error("IndexedDB open was blocked (another connection is holding an older schema version)"));
  });
}

/** Assembles the WorkspaceState planMutation needs using only the set of
 * paths -- see the file header; the content values themselves are
 * placeholders that planMutation never reads. */
function placeholderState(paths: readonly string[], revision: number): WorkspaceState {
  const files = new Map<string, WorkspaceFile>();
  for (const path of paths) {
    files.set(path, { kind: "text", path, text: "" });
  }
  return { revision, files };
}

export interface IndexedDbWorkspaceStorageOptions {
  /** The underlying IDBFactory -- production defaults to
   * `globalThis.indexedDB`; tests (fake-indexeddb) inject `new IDBFactory()`
   * to get a clean, isolated fake database. */
  readonly indexedDB?: IDBFactory;
  /** The database name -- two adapter instances for the same workspace (e.g.
   * before/after a reload) must use the same indexedDB + the same dbName to
   * read the same data. */
  readonly dbName?: string;
}

/**
 * The IndexedDB implementation of WorkspaceStoragePort. This adapter itself
 * caches no workspace state (no in-memory copy of revision/files) --
 * list()/readFile()/mutate() each open a transaction directly against
 * IndexedDB every time to read the latest state, so the OCC check naturally
 * treats "the revision read inside the transaction" as authoritative, with
 * no risk of "the adapter's in-memory cache is out of sync with the
 * database's actual content".
 */
export class IndexedDbWorkspaceStorage implements WorkspaceStoragePort {
  readonly #indexedDB: IDBFactory;
  readonly #dbName: string;
  #db: IDBDatabase | undefined;

  constructor(options: IndexedDbWorkspaceStorageOptions = {}) {
    this.#indexedDB = options.indexedDB ?? globalThis.indexedDB;
    this.#dbName = options.dbName ?? DEFAULT_DB_NAME;
  }

  async open(): Promise<void> {
    if (this.#db) return; // already open -- open() is idempotent
    this.#db = await idbOpenDatabase(this.#indexedDB, this.#dbName, DB_VERSION);
  }

  async close(): Promise<void> {
    this.#db?.close();
    this.#db = undefined;
  }

  #requireDb(): IDBDatabase {
    if (!this.#db) {
      throw new Error("IndexedDbWorkspaceStorage: not open() yet -- can't operate on the workspace");
    }
    return this.#db;
  }

  async list(): Promise<WorkspaceSnapshot> {
    const db = this.#requireDb();
    const tx = db.transaction([FILES_STORE, META_STORE], "readonly");
    const done = idbTransactionDone(tx);
    const filesReq = tx.objectStore(FILES_STORE).getAll() as IDBRequest<WorkspaceFile[]>;
    const revisionReq = tx.objectStore(META_STORE).get(REVISION_KEY) as IDBRequest<number | undefined>;
    const [records, revision] = await Promise.all([idbRequest(filesReq), idbRequest(revisionReq)]);
    await done;

    const entries: WorkspaceEntry[] = records
      .map((file) => ({ path: file.path, kind: file.kind, byteLength: byteLengthOf(file) }))
      .sort((a, b) => a.path.localeCompare(b.path));
    return { revision: revision ?? 0, entries };
  }

  async readFile(path: string): Promise<WorkspaceFile | undefined> {
    const db = this.#requireDb();
    const tx = db.transaction(FILES_STORE, "readonly");
    const done = idbTransactionDone(tx);
    const req = tx.objectStore(FILES_STORE).get(path) as IDBRequest<WorkspaceFile | undefined>;
    const record = await idbRequest(req);
    await done;
    return record ? cloneFile(record) : undefined;
  }

  async mutate(mutation: WorkspaceMutation): Promise<WorkspaceMutationResult> {
    const db = this.#requireDb();
    const tx = db.transaction([FILES_STORE, META_STORE], "readwrite");
    const done = idbTransactionDone(tx);
    const filesStore = tx.objectStore(FILES_STORE);
    const metaStore = tx.objectStore(META_STORE);

    // The OCC check treats the revision read inside this transaction as
    // authoritative, trusting no in-memory adapter cache (this adapter has
    // none to begin with) -- when two tabs/two call sequences operate on the
    // same IndexedDB database at once, IndexedDB's transaction serialization
    // guarantees what's read here is always the latest already-committed
    // state so far. See the file header's "Transaction / OCC strategy"
    // section.
    const [paths, revision] = await Promise.all([
      idbRequest(filesStore.getAllKeys() as IDBRequest<string[]>),
      idbRequest(metaStore.get(REVISION_KEY) as IDBRequest<number | undefined>),
    ]);
    const state = placeholderState(paths, revision ?? 0);

    const planResult = planMutation(state, mutation);
    if (!planResult.ok) {
      // This transaction never issues any write request from start to finish,
      // so letting it complete normally (a no-op) is fine -- no need to
      // abort, since the database state was never touched in the first
      // place.
      await done;
      return { ok: false, error: planResult.error };
    }

    try {
      for (const op of mutation.ops) {
        if (op.op === "delete") {
          filesStore.delete(op.path);
        } else if (op.kind === "text") {
          filesStore.put({ kind: "text", path: op.path, text: op.text } satisfies WorkspaceFile);
        } else {
          filesStore.put({ kind: "blob", path: op.path, bytes: op.bytes.slice() } satisfies WorkspaceFile);
        }
      }
      metaStore.put(planResult.plan.nextRevision, REVISION_KEY);
    } catch (error) {
      // Any put/delete throwing synchronously (including a persistence
      // failure a test injects on purpose) -- abort the whole transaction:
      // IndexedDB guarantees every write already queued in this transaction
      // gets rolled back, returning the object store to the state it was in
      // before the transaction started -- i.e. before this mutate() call --
      // leaving no half-written data behind.
      try {
        tx.abort();
      } catch {
        // May already be in the middle of aborting (e.g. a request error
        // triggered an automatic browser abort) -- a repeated call to
        // abort() here isn't treated as a new error; the code below
        // uniformly waits for the transaction to actually end before
        // wrapping up.
      }
      await done.catch(() => {
        // The transaction is guaranteed to end via abort (reject) here; this
        // swallows that and surfaces the original exception instead, so the
        // real persistence-failure reason isn't masked.
      });
      throw error;
    }

    // Wait for the transaction to actually commit -- this is also where any
    // asynchronous request error (e.g. quota exceeded) would reject; when it
    // rejects, IndexedDB guarantees none of this transaction's writes took
    // effect.
    await done;
    return { ok: true, revision: planResult.plan.nextRevision };
  }
}
