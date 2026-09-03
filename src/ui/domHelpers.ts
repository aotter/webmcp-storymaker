// A shared DOM helper pulled out on its own -- both ./dom.ts and
// ../map/render.ts need the same `el()` constructor (generic element construction); it lives in its
// own file to avoid a circular dependency from the two importing each other (./dom.ts needs to call
// ../map/render.ts's `createMapEditorView()`; if ../map/render.ts also imported ./dom.ts, that would
// form a cycle). This file depends on neither ./controller.ts nor ./dom.ts -- both can depend on it
// one-way.
//
// There is no `applyNotice()`/`Notice` notification-bar renderer here -- the only path that
// writes to the workspace is WebMCP (docs/architecture.md's "WebMCP is the only write path"),
// so there's no local UI action whose result needs a one-off "Saved."/"Import complete" message.
// The only error display left is the error view's `state.message`, a direct textContent
// assignment, needing no shared component. There are likewise no backup export/restore helpers
// here -- this screen has no backup export/restore buttons at all.
//
// Zero validation/business logic (existing discipline) -- a pure DOM-assembly helper, untested.
export function el(tag: string, className?: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
