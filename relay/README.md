# Preview relay

A Cloudflare Worker + Durable Object that relays the WebSocket messages
between a creator's browser tab (**host**) and a phone reader (**viewer**)
during QR-code preview pairing. It only forwards — it never writes to KV, R2,
D1, cache, or the Durable Object's own storage. The story only ever lives on
the creator's device; during a preview session it is not persisted anywhere
in the cloud, only relayed over an encrypted connection.

This is a standalone package: its own `package.json`, `wrangler.jsonc`, and
`tsconfig.json`. It is not part of the web app's Vite build and does not
share the web app's dependency tree. The one thing it shares with the web app
is the wire protocol's *type* contract — see
[`../src/preview/protocol.ts`](../src/preview/protocol.ts)'s header for why
that sharing is type-only, and for the full reasoning behind the credential
design (`hostKey`/`viewerToken`/`sid` hash chain — see "Credentials" below),
the routing scheme (`sid` query parameter), and the base64-in-JSON transport
choice for image bytes.

## Credentials: a hash chain, not a shared token

An earlier version of this relay had host and viewer share one `token`,
which the relay would remember from the host's `hello` and compare the
viewer's `hello` against. The flaw: this DO has no
storage, so it can be evicted by the runtime any time it has no open sockets
or timers, and a fresh instance under the same `sid` remembers nothing.
Anyone who had ever seen the viewer-facing token (the one that travels
through the QR code / URL fragment) could replay it as a **host** `hello`
against a freshly-evicted instance and take over as host.

The fix is a one-way hash chain, so verification never needs memory:

```
hostKey     = base64url(32 random bytes)                — 43 chars, never leaves the host tab
viewerToken = base64url(sha256(utf8(hostKey)))           — 43 chars, goes in the QR / URL fragment
sid         = hex(sha256(utf8(viewerToken)))             — 64 hex chars, goes in ?sid=
```

Host `hello` carries `hostKey`; the relay hashes it twice and checks the
result equals the connection's `sid`. Viewer `hello` carries `token` (the
viewerToken); the relay hashes it once and checks the same thing. Neither
check needs any remembered state — the `sid` a connection was routed under
*is* the verification anchor, so it works identically no matter how many
times the Durable Object has been evicted and recreated in between. Someone
holding only the viewerToken cannot compute a valid `hostKey` (that's what
makes the hash one-way), so they can never become host — at most they can
connect as a viewer and wait for an approval that will never come without a
live host tab. See `../src/preview/protocol.ts`'s "credential design" section for the
full derivation and `src/session-do.ts`'s header for what actually happens
after an eviction.

`generateHostKey()` / `deriveViewerToken()` / `deriveSid()` in
`../src/preview/protocol.ts` are the canonical implementation the web app
should call directly (non-type-only import) when it wires up the host tab
and the viewer reader. `relay/src/crypto.ts` is an independent mirror used
only for verification (the relay never generates a hostKey).

## Pairing flow

```
host                         relay (SessionDO)                    viewer
 |--- hello{host,hostKey} --------->|
 |<---------- host-ready{code} ----|
 |                                 |<---- hello{viewer,token} ---------|
 |                                 |---------- awaiting-approval{code}->|
 |<----- pair-request -------------|
 |--- pair-approve ---------------->|
 |                                 |------------- pair-approve -------->|
 |                                 |<--------- snapshot-request --------|
 |--- snapshot-request (fwd) ------|  (forwarded, shown for symmetry)
 |--- snapshot-manifest ---------->|------------ snapshot-manifest ---->|
 |--- image-chunk (xN) ------------>|-------------- image-chunk (xN) --->|
 |--- snapshot-complete ----------->|------------ snapshot-complete ---->|
```

Any validation failure, TTL expiry, or disconnect ends with an `error`
message (a closed code, never free text) and the WebSocket close code table
below.

## Protocol message table

Direction is relative to the relay. "fwd" means the relay forwards the
message byte-for-byte without altering it (it still validates the shell
shape/size — see `src/validate.ts`).

| type | direction | fields | notes |
|---|---|---|---|
| `hello` (host) | host → relay | `role: "host"`, `hostKey` | must be the first message on every host connection; verified against the connection's `sid` |
| `hello` (viewer) | viewer → relay | `role: "viewer"`, `token` | must be the first message on every viewer connection; verified against the connection's `sid` |
| `pair-approve` | host → relay → viewer (fwd) | — | consumes the viewerToken; starts the idle TTL |
| `pair-reject` | host → relay → viewer (fwd) | — | does **not** consume the viewerToken; host keeps waiting |
| `snapshot-request` | viewer → relay → host (fwd) | — | only accepted once paired |
| `snapshot-manifest` | host → relay → viewer (fwd) | `snapshot: PreviewSnapshot` | relay only validates the shell (story is an object, images' declared sizes) — see `src/validate.ts` header |
| `image-chunk` | host → relay → viewer (fwd) | `id`, `index`, `total`, `dataBase64` | relay checks index continuity and cumulative bytes vs. the manifest's declared `byteLength` |
| `snapshot-complete` | host → relay → viewer (fwd) | — | clears the relay's per-image chunk-progress tracking |
| `host-ready` | relay → host | `pairingCode` | |
| `pair-request` | relay → host | — | a viewer just presented a matching viewerToken |
| `awaiting-approval` | relay → viewer | `pairingCode` | |
| `error` | relay → either | `code` (closed enum, no free text) | see close-code table |
| `host-offline` | relay → viewer | — | host disconnected, or the whole session ended for a host-attributed fault |
| `session-expired` | relay → either | — | a TTL fired |

## Error codes and close codes

| code | close code | when |
|---|---|---|
| `host-offline` | 4001 | host disconnected, or the whole session ended because of something the host did, or a viewer connects before any host ever has |
| `session-expired` | 4002 | pairing/idle/absolute TTL fired |
| `protocol-violation` | 4003 | malformed message, wrong role for a message type, duplicate host, duplicate concurrent viewer, out-of-order chunk index, chunk for an undeclared image id, no valid `hello` within the pre-auth window |
| `invalid-token` | 4004 | a `hostKey`/`token` that doesn't hash to the connection's `sid`, or a `sid` that cannot be routed to any session |
| `token-consumed` | 4005 | a second viewer after the viewerToken has already been approved once |
| `not-paired` | 4006 | `snapshot-request` sent before the host approved pairing |
| `too-large` | 4007 | manifest/chunk exceeds a size cap, or cumulative chunk bytes exceed the manifest's declared image size |
| `rate-limited` | 4008 | a single connection sent more than `RATE_LIMIT_MAX_MESSAGES` messages within `RATE_LIMIT_WINDOW_MS` (per-connection, not shared across the session — see "Rate limiting" below; the host's `image-chunk` messages are exempt from the count — they are bounded by the manifest's declared byte sizes, the per-image/total caps and index continuity instead) |

A rejected *new* connection (second host, second concurrent viewer, bad
credential, pre-auth timeout, an unauthenticated connection's own rate
limit) only closes that one connection — the existing host/viewer pairing is
untouched. A fault attributed to the established host ends the whole session
(host gets the real code, viewer gets `host-offline`). A fault attributed to
the viewer only closes the viewer. See `src/session-do.ts`'s header for the
full reasoning.

## Rate limiting (per-connection, not session-wide)

An earlier version tracked one message counter for the whole session, so
anyone who obtained a `sid` (not secret, but not fully unguessable either —
see "DO routing" in the protocol header) could flood a handful of garbage
messages and take down a legitimate, in-progress transfer. Rate limiting is
now tracked **per WebSocket connection**:

- A connection that hasn't sent a valid `hello` yet gets exactly one message
  — it must be a valid `hello` or the connection is closed immediately
  (`protocol-violation` or `invalid-token`, whichever applies). A connection
  that sends nothing at all within `PRE_AUTH_TIMEOUT_MS` (10 s) is also
  closed. Neither ever touches an existing host/viewer pairing.
- Once promoted to host or viewer, that connection gets its own
  `RATE_LIMIT_MAX_MESSAGES` / `RATE_LIMIT_WINDOW_MS` counter. Exceeding it is
  just another fault, dispatched through the same host/viewer attribution
  rule as everything else (host flooding ends the session; viewer flooding
  only closes the viewer).

## Limits and TTLs

Mirrored from `../src/preview/protocol.ts` in `src/protocol-limits.ts` (why
they're a separate, independently-maintained copy rather than a shared
import is explained in that file's header — short version: relay only
type-only imports `protocol.ts`, so the numeric constants can't cross that
boundary as values). `test/protocol-parity.test.ts` value-imports both files
and asserts every constant, pattern, and the error/close-code table actually
match — a mirror without that test is just a bug waiting to happen.

| constant | value |
|---|---|
| max image size | 5 MiB |
| max total image bytes per snapshot | 20 MiB |
| max chunk size | 32 KiB (raw), ~43.7 KB base64-encoded |
| max manifest JSON size | 256 KiB |
| rate limit | 200 messages / 10 s, per connection |
| pairing TTL | 5 minutes |
| idle TTL (post-pairing) | 10 minutes |
| absolute TTL | 60 minutes |
| pre-auth timeout | 10 seconds (a connection must send its `hello` by then) |
| `hostKey` / `viewerToken` shape | `/^[A-Za-z0-9_-]{43}$/` (base64url, no padding) |
| `sid` shape | `/^[0-9a-f]{64}$/` |

The TTLs and the pre-auth timeout are also exposed as `wrangler.jsonc` vars
(`PAIRING_TTL_MS`/`IDLE_TTL_MS`/`ABSOLUTE_TTL_MS`/`PRE_AUTH_TIMEOUT_MS`) so
tests can override them to much shorter values — see `vitest.config.ts`.
Production values are the real figures above; there's no reason to change
them without also updating `protocol-limits.ts`.

## Zero storage

`src/session-do.ts`'s header explains this in full (the trade-off, and why
the standard, non-hibernating WebSocket API was chosen over the Hibernation
API specifically because of it). Short version: no `ctx.storage` /
`state.storage` call anywhere in `relay/src`, no KV/R2/D1/Queues/Analytics
Engine binding anywhere in `wrangler.jsonc`; all session state — sockets,
pairing code, TTL timers, per-connection rate-limit counters,
chunk-sequence tracking — lives only in the `SessionDO` instance's memory.

**What actually happens when the instance is evicted** (this used to be
described here as "the same as a TTL firing" — that glossed over a real
security gap; see "Credentials" above for the fix and the full story):
a fresh instance under the same `sid` remembers nothing about who was host,
who was paired, or whether a viewerToken had been consumed. But it doesn't
need to — the hash-chain credentials are verified as a pure function of the
`sid` itself, so the *only* thing anyone can do afterward is present a
`hostKey` (which only the original creator's tab ever had) to become host
again, or a `viewerToken` to wait as a viewer. Whoever only has the
viewerToken — which is everyone except the creator's own tab, since that's
the only thing that ever went into the QR code — can never become host, and
without a live host there is no `pair-approve`, so they simply wait
(functionally identical to a TTL expiry or the host disconnecting: the
session has to be re-established, either by the same creator's tab
reconnecting or by scanning a fresh QR code).

TTLs run on plain `setTimeout`, not `alarm()` (an alarm is itself a
`ctx.storage` call).

Verify with:

```bash
node scripts/check-no-storage.mjs
```

(also run automatically as the first step of `pnpm test`). This checks both
`relay/src` (for `storage`/`caches`/`KVNamespace`/`R2Bucket`/`D1Database`/
`setAlarm`/`alarm(`/`Queue`/`AnalyticsEngine`, all case-insensitive) and
`wrangler.jsonc` (parsed as JSONC, asserting none of `kv_namespaces` /
`r2_buckets` / `d1_databases` / `queues` / `analytics_engine_datasets` are
declared).

## Known limitation: a disconnected viewer must re-scan

If the viewer's own connection drops after pairing (phone locks, network
blip, browser tab closed), there is currently no reconnection path — the
viewerToken has already been consumed by the approval, so a second `hello`
with the same token is rejected as `token-consumed`. The user has to scan a
fresh QR code (which the host tab would need to regenerate — a new
session). This is a deliberate scope cut rather than an oversight: fixing it
properly means deciding what "the same viewer reconnecting" should even mean
without any server-side memory of who that was, and that's a product
question for the web app to decide, not something to improvise here.

## Testing

### The test tooling choice

`wrangler` (installed here) actively recommends `@cloudflare/vitest-plugin`
over the older `@cloudflare/vitest-pool-workers` — running `wrangler types`
prints the migration notice, and the current Cloudflare Workers Vitest
integration docs exclusively document `@cloudflare/vitest-plugin` /
`cloudflareTest()`. This package uses that current path (`vitest@^4.1.0` +
`@cloudflare/vitest-plugin`), not the older pool-workers package — the
older package's known-issues page describes a
storage-isolation limitation for WebSocket + Durable Object tests, and the
newer plugin's option schema doesn't expose an equivalent toggle at all. In
practice the full WebSocket + DO test suite here runs cleanly under it; since
this DO is zero-storage to begin with, that isolation concern is moot for us
either way (there's no persisted state to isolate between test files).

### What's covered

- Happy path: `hello` (host, `hostKey`) → `hello` (viewer, `token`) →
  `pair-approve` → `snapshot-manifest` / `image-chunk` / `snapshot-complete`
  forwarded to the viewer in order.
- Hash-chain credential validation: a `hostKey` that doesn't hash to the
  connection's `sid`; an attacker presenting the viewerToken *as* a hostKey
  (proven unable to ever become host); a viewer presenting a hostKey in the
  `token` field. All → `invalid-token`.
- Empty/malformed `hostKey`, a viewer `token` that doesn't match the host's,
  and a viewer connecting before any host has ever connected (→
  `host-offline`).
- A second viewer after the viewerToken has been consumed → `token-consumed`;
  the already-paired viewer is unaffected.
- `snapshot-request` before approval → `not-paired`; host keeps waiting and a
  retry with the same viewerToken can still pair.
- Host disconnect → viewer receives `host-offline` and is closed (both while
  awaiting approval and after pairing).
- Pairing TTL expiry (shortened for the test, see above) → `session-expired`
  for host and any waiting viewer.
- A connection that never sends a `hello` within the (shortened, for the
  test) pre-auth window → closed with `protocol-violation`.
- Oversized `snapshot-manifest` (declared image bytes over the 20 MiB total
  cap), an oversized `image-chunk` base64 payload, and chunks whose
  cumulative decoded bytes exceed the manifest's declared `byteLength` — all
  → `too-large`.
- Out-of-order chunk index, and a chunk for an image id never declared in the
  manifest → `protocol-violation`.
- A second concurrent host connection → `protocol-violation`, existing
  pairing undisturbed.
- A viewer sending a host-only message (`pair-approve`) → `protocol-violation`,
  only the viewer closed.
- A completely malformed first message → `protocol-violation`.
- `pair-reject` → forwarded to the viewer verbatim, only the viewer closed
  (close code 1000, not an error code), viewerToken stays usable for a retry.
- Per-connection rate limiting: an unauthenticated third connection flooding
  250 garbage messages only gets itself closed while the paired session's
  own snapshot transfer completes normally; an authenticated viewer
  exceeding its own limit only closes the viewer; an authenticated host
  exceeding its own limit ends the whole session (viewer gets
  `host-offline`).
- The `Worker` routing layer (`src/index.ts`): `/health` returns constant
  JSON with CORS headers gated on `ALLOWED_ORIGIN`; `/session` rejects a
  mismatched `Origin` before ever touching a Durable Object; a missing or
  malformed `sid` completes the handshake and sends `invalid-token` without
  involving any DO; a well-formed `sid` routes to a real `SessionDO`, and the
  same `sid` twice lands on the same instance (proven via the
  second-host-rejected behavior, which is only observable within one shared
  instance).
- `../src/preview/protocol.ts`'s runtime validators (`src/preview/protocol.test.ts`,
  at the repo root, not under `relay/`): null/array/missing-field/malformed-pattern/
  bad-enum-code inputs all fail closed for every message-shape guard.
- `test/protocol-parity.test.ts`: every constant, pattern, and the
  error/close-code table mirrored between `../src/preview/protocol.ts` and
  `src/protocol-limits.ts` actually match.

Run everything:

```bash
pnpm test          # from relay/, or `pnpm relay:test` from the repo root
```

## Development

```bash
pnpm install
pnpm dev            # wrangler dev, local only
pnpm typecheck      # regenerates worker-configuration.d.ts first, then type-checks
pnpm test           # regenerates it too, then runs the zero-storage check + vitest
pnpm types          # just the regeneration step, on its own
```

`worker-configuration.d.ts` (the `wrangler types` output) is gitignored, not
committed — see `tsconfig.json`'s header for why (short version: it embeds
Cloudflare's entire platform API surface, most of it unrelated to this
package). `typecheck`/`test` regenerate it automatically, so
there's nothing to remember to keep in sync by hand.

For local `wrangler dev`, copy `.dev.vars.example` to `.dev.vars`
(git-ignored) to point `ALLOWED_ORIGIN` back at the web app's local dev
server — `wrangler.jsonc`'s own `ALLOWED_ORIGIN` value is a placeholder for
the deployed front end, not a local address.

## Deploy

This section documents how a human deploys this package; it is not
automated by any tooling in this repo.

**Authentication**: either run `wrangler login` interactively once, or set
`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` as environment variables
(no token value is written anywhere in this repository — `wrangler.jsonc`
only has the non-secret `account_id`, which identifies the account, not a
credential).

**Order**:

1. Deploy the relay first, so its `*.workers.dev` URL exists:
   ```bash
   pnpm relay:deploy    # from the repo root, or `pnpm --dir relay exec wrangler deploy`
   ```
2. Build and deploy the web app to Cloudflare Pages:
   ```bash
   pnpm pages:deploy
   ```
   This runs `pnpm build` first, which builds in Vite's `production` mode —
   `VITE_PREVIEW_RELAY_URL` is read from the repo root's `.env.production`
   (committed; see `README.md`'s "Preview" section), not from any local-only
   file. If the relay's actual deployed address differs from what's in
   `.env.production` (e.g. a different account's `workers.dev` subdomain),
   update that file before running `pnpm pages:deploy`, the same way step 3
   below says to update `wrangler.jsonc`'s `ALLOWED_ORIGIN` if the web app's
   address differs from its placeholder.
3. If the web app's actual deployed URL differs from the `ALLOWED_ORIGIN`
   placeholder already in `wrangler.jsonc`, update it there (or pass
   `wrangler deploy --var ALLOWED_ORIGIN:<actual-url>`) and re-run
   `pnpm relay:deploy` — the relay only accepts `/session` connections whose
   `Origin` header matches this value exactly.
