# Architecture

## What this is

A browser-local story workshop: a single-page web app that keeps a story's
draft entirely inside the creator's browser (IndexedDB, scoped to this origin
in that browser profile), and exposes that same draft to an
AI agent running in the same browser via [WebMCP](https://github.com/webmachinelearning/webmcp)
(`document.modelContext`). This is a pure AI-operation interface: the page
itself has no authoring form, no free-text editor, and no file picker — a
human writes and illustrates a story entirely by talking to a WebMCP-capable
agent sharing the tab, through the seven tools in `src/webmcp/tools/`
(README "The seven WebMCP tools"). What the page gives the human directly is
read-facing: a visual map of the story, a read-only detail view, an
immersive reader, and a QR-code panel to preview on a phone.

## Storage: a virtual YAML workspace, not a bespoke format

A story lives as a small `path -> text/blob` virtual file tree (an "IndexedDB
workspace"), shaped like a directory: a `story.yaml` (the story's structure,
in the StorySpec grammar — see `docs/STORYSPEC.md`), a `meta.json` (title),
`content/<page>.en.txt` fragments (one file per page of English prose), and
`media/<slug>.<ext>` image files. This isn't a new format invented for the
browser — StorySpec is a plain, human-readable YAML grammar, independent of
where it happens to be stored. IndexedDB is just the storage backend for it.

Scope of that storage: one workspace per browser profile per origin, under
the fixed database name `storymaker-workspace`. It is not per tab -- every
tab of this site in the same profile sees the same story, and so does every
agent attached to any of those tabs. A new tab or a new agent is therefore
not a clean workspace; the only way to start over is the human "Delete story"
button (see "WebMCP is the only write path" below). The phone preview never
reads this database at all: it renders the snapshot the creator's browser
sends through the relay, and holds nothing once the session ends.

## WebMCP is the only write path

Every mutation to the workspace — creating a story, restructuring it,
writing a page's prose, setting a page's illustration — goes through one of
the four write tools in `src/webmcp/tools/writeTools.ts`. There is no second,
human-operated write path: the page renders the workspace (map, read-only
page detail, preview reader) but never writes to it. When
`document.modelContext` isn't present (no agent installed, or a browser that
doesn't support WebMCP), the page still renders whatever is already in the
workspace — it just has no way to change it until an agent attaches.

The one exception is destruction: the header's "Delete story" button wipes the
whole workspace after a native `confirm()`. It is deliberately not exposed as a
WebMCP tool, so an agent can never erase the creator's only copy on its own;
starting over is a human gesture.

Each write tool takes an `expectedRevision` and is rejected outright if the
workspace has moved on since the caller last read it (see "Storage" above) —
a stale write never silently clobbers a newer one. A successful write also
triggers the page to re-hydrate itself from the workspace, so a human
watching the map sees the agent's changes appear without doing anything.

## No manual approval gate for media

`set_page_image` writes a page's illustration (bytes the agent generated or
otherwise obtained itself — the tool never accepts a URL) as soon as the
call succeeds, checked only by content (extension + magic-byte match against
the same png/jpg/jpeg/webp allowlist used elsewhere, plus a size limit) —
there is no separate human approval step standing between an agent's image
and the story's actual media list.

## Zero cloud, zero server

There is no backend for this app. Everything — the draft, the AI
conversation — stays in the browser's local storage on the device. Nothing
is ever uploaded anywhere. Closing the tab leaves the draft exactly where it
was, on that device, in that browser profile.

## Dependency boundary

The `src/` tree may not import Node built-ins (`fs`, `node:*`, etc. — there
is no Node runtime in the browser) and may not use relative imports that
escape `src/`. This is enforced automatically by `scripts/check-boundary.ts`,
not left as a convention — see `pnpm check`.
