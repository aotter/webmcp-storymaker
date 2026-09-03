# StoryMaker

*A browser-based story workshop -- a human and an AI agent co-write a story together through WebMCP. Stories stay on the creator's device. Nothing is persisted to the cloud during preview; it is only relayed over an encrypted connection.*

A browser-local story workshop where a human and an AI agent co-write a
children's story together, using [WebMCP](https://github.com/webmachinelearning/webmcp)
(`document.modelContext`) as the bridge between them. This is a **pure
AI-operation** interface: there is no manual authoring form, no free-text
editor, and no file picker anywhere on the page — the only way a story gets
written, restructured, or illustrated is through the WebMCP tools below,
called by a WebMCP-capable agent sharing the tab (for example, the built-in
browser inside the ChatGPT desktop app). What the page itself gives a human
is entirely read-facing: a visual map of the story's structure, a read-only
detail view of whichever page is selected, an immersive reader to preview
the story as a child would experience it, and a QR-code panel to hand that
same reader to a phone. The story (draft text, images) is kept only on the
creator's device, in browser storage for this origin and profile; there is no server behind
the editor. During a phone preview the story is not persisted anywhere in
the cloud, it is only relayed over an encrypted connection (see "Preview"
below).

## Design principles

- **The agent is the only author.** There is deliberately no editing UI: no forms, no text
  fields, no upload button. A human shapes the story by talking to an AI agent, and the agent
  writes, restructures and illustrates it through seven WebMCP tools. The page itself only
  shows: a read-only story map, page details, and a reader.
- **The tools are the interface.** Each tool description carries the rules an agent needs
  (closed StorySpec shape, revision checks so a stale write never clobbers a newer one, the
  "about 5 pages, one branch, two endings" nudge). No agent-specific code: any WebMCP-capable
  agent works.
- **Local-first, no server.** The story lives only in the creator's browser storage. There is
  no backend, no account, no API key, nothing to sign up for.
- **Phone preview without storing anything.** The phone reads a snapshot relayed live from the
  creator's browser through a zero-storage Worker, after the creator confirms the pairing by
  hand. When the session ends, nothing remains on the relay.
- **Destruction stays human.** The one write a person can perform is "Delete story", behind a
  confirmation. Agents cannot erase the creator's only copy.

## How to try it

A live build is at <https://webmcp-storymaker.pages.dev> (phone reader at `/preview`).

1. Open the live URL, or run `pnpm install && pnpm dev` and open the printed local URL.
2. Open that URL in a browser context that exposes `document.modelContext`
   to an AI agent — for example, the built-in browser inside the ChatGPT desktop app.
3. Ask the agent what tools are available on the page (e.g. "what site tools
   do you see?") — it should list the seven tools below. With an empty
   workspace, just ask it to start a story (e.g. "write me a bedtime story
   about a firefly, aim for 5 pages with two different endings") — the page
   has no form to fill in yourself.
4. Watch the story map fill in as the agent writes; click a card for the page's text, art,
   previous pages and destinations. "Preview reader" reads the story in the page; "Phone preview"
   hands it to a phone (see "Preview" below).
5. To start over, the trash icon in the header ("Delete story") wipes the workspace after a
   confirmation. It is deliberately not a WebMCP tool: erasing the creator's only copy is a
   human gesture.

## The seven WebMCP tools

Read-only:

- **`inspect_story`** — a structured overview of the current story: title/slug,
  each page's id and a rough sense of whether/how much it's been written, a
  summary of any structural validation problems, and the workspace's current
  revision number.
- **`get_story_readiness`** — checks whether the story is complete: structural
  errors/warnings, which pages still have no text, how many media files are
  missing, plus a plain-language summary of all of that.
- **`get_editor_focus`** — reports where the human or agent currently claims
  to be looking in the story (which story/page/tab), already revalidated
  against the live workspace so stale claims never come back.

Write (each guarded by an expected-revision check, so a stale write is
rejected rather than silently overwriting someone else's edit; a successful
write triggers the page to re-read the workspace on its own, so the human
sees the result immediately without pressing anything):

- **`create_story`** — creates a minimal, valid one-page story in an empty
  workspace. Only works when the workspace is completely empty.
- **`update_story_structure`** — replaces the story's structure with a full
  StorySpec object, validated before it's accepted.
- **`update_page_text`** — overwrites the prose text of a single page.
- **`set_page_image`** — sets a page's illustration from base64 image bytes
  the agent generated or otherwise produced itself (no URLs accepted). There
  is no manual-approval step — the write lands as soon as the call succeeds.
  The usual order is `update_page_text` first, then `set_page_image` for the
  same page. The image is checked (by content, not just its claimed type)
  against the same png/jpg/jpeg/webp allowlist used everywhere else in this
  app, up to 5MiB; a page that already has an image gets it replaced.

## Preview

The story can be read back as a reader would see it, through a single shared
`PreviewReader` component (`src/preview/reader.ts`) that only knows how to
render a `PreviewSnapshot` — where that snapshot comes from is abstracted
behind a `PreviewSource` adapter (`src/preview/source.ts`). Two ways to read
that same reader:

- **On the creator's own tab** — the "Preview reader" tab next to "Story map" in the
  editor, backed by `LocalSource`
  (`src/preview/localSource.ts`), reading the creator's local workspace
  directly. No network involved.
- **On a phone, by scanning a QR code or pasting a link** — the "Phone preview" tab starts a
  session: the creator's tab becomes the **host**, generates a one-time credential chain
  (`src/preview/protocol.ts`), and shows a QR code (rendered locally with
  `qrcode-generator`, no external service), the same link as copyable text with a "Copy link"
  button (handy for a phone simulator), plus a 4-digit pairing code. The
  QR encodes a link to the standalone `preview.html` entry point with the
  viewer's credential in the URL fragment (`#t=<viewerToken>`, never sent to
  any server as a query parameter or path segment). Opening that link is the
  **viewer** side, backed by `RelaySource` (`src/preview/relaySource.ts`).

Both sides talk through [`relay/`](relay/) — a Cloudflare Worker + Durable
Object that only forwards WebSocket messages, never stores anything (see
"Preview relay" below). The flow:

1. The phone connects and requests pairing; the pairing code is shown on
   **both** devices so the creator can visually confirm they match.
2. The creator explicitly taps "Allow" or "Reject" on their own
   tab — this is a deliberate manual confirmation, never automatic.
3. Once approved, the creator's tab sends the same `PreviewSnapshot` shape
   used for local preview (built from `LocalSource`), chunked and streamed
   over the relay to the phone, which renders it through the same shared
   `PreviewReader`.
4. Either side can end the session ("End preview"/leaving the tab closes the
   connection); the relay also enforces pairing/idle/absolute TTLs (5/10/60
   minutes) so an abandoned session doesn't linger — see `relay/README.md`
   for the full limits table, wire protocol, and error/close-code reference.

`preview.html` is a read-only, preview-only surface regardless of which
`PreviewSource` backs it: it registers no editing UI and no WebMCP tools at
all — `pnpm smoke:build` mechanically checks the chunk it builds into for
exactly that (it may only ever pull in `src/preview/reader.ts`,
`src/preview/relaySource.ts`, `src/preview/protocol.ts`, and
`src/preview/snapshot.ts`).

The story only ever lives on the creator's device. During a phone preview it
is not persisted to any server — the relay only relays WebSocket messages
between the two devices over an encrypted connection, and a session ends the
moment either device disconnects or a TTL expires.

The relay's address is read from `VITE_PREVIEW_RELAY_URL` at build time
(`.env.development` for `pnpm dev`, `.env.production` for `pnpm build`/
`pnpm pages:deploy` — both committed, since a relay's own address isn't a
secret). If it's unset, "Mobile preview" reports the relay as unreachable rather
than silently doing nothing.

## Architecture

See [`docs/architecture.md`](docs/architecture.md) for how the workspace is
stored, why WebMCP is progressive enhancement rather than a hard dependency,
and the dependency boundary the app is built against.

## Preview relay

[`relay/`](relay/) is a separate, standalone package: a Cloudflare Worker +
Durable Object that lets a phone scan a QR code and read a live preview of
the story open in the creator's own browser. The story only ever lives on
the creator's device — during a preview session it is not persisted to the
cloud, it is only relayed to the phone over an encrypted connection. The
relay itself writes nothing to any storage layer (no KV, R2, D1, or Durable
Object storage); it only forwards WebSocket messages between the two
devices, and a session ends the moment either device disconnects or a
time-to-live expires. See [`relay/README.md`](relay/README.md) for the wire
protocol, limits, and how to run it locally with `pnpm relay:dev`.

## Development

```bash
pnpm install         # install dependencies
pnpm dev             # local dev server
pnpm build           # production build
pnpm check           # typecheck + dependency boundary check
pnpm test            # run the full test suite
pnpm test:workspace  # workspace-layer tests only
pnpm test:webmcp     # WebMCP wiring tests only
pnpm smoke:build     # build, then verify the build output is clean
pnpm relay:dev       # local dev server for the preview relay (relay/)
pnpm relay:test      # the preview relay's own test suite
```

Node 22 is required (see `.nvmrc`).

## License

MIT — see [`LICENSE`](LICENSE).
