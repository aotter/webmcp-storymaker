// PreviewReader - DOM binding "too thin to be worth testing" (the
// same discipline as the ../ui/dom.ts header). The testable logic has already been split out
// into separate pure-function files: the reading-position state machine is in
// ./readerState.ts, snapshot assembly is in ./buildPreviewSnapshot.ts, error copy is in
// ./messages.ts - this file only does three things: calls PreviewSource to get data, renders
// that data, and turns user interaction (button presses) into state-machine calls.
//
// This is the **only** component shared by the creator's local preview and the phone-QR-scan
// preview - PreviewReader is a single shared component; this file only
// depends on ./source.ts's PreviewSource interface and ./snapshot.ts's data shapes, with no
// idea whether it's backed by LocalSource or RelaySource, and it imports nothing under
// ../ui/**, ../map/**, or other creator-only modules (a boundary requirement of the
// preview.html entry point).
//
// Generation guarding: loading an image (source.image()) is asynchronous, and the user may
// already have turned the page before the image finishes reading - following the existing
// discipline in ../ui/controller.ts (check that the world is still the same one before and
// after every await), this uses a monotonically increasing `imageRequestToken` to reject stale
// image-load results, so a slow-arriving old page's illustration never overwrites the new page
// the user has already turned to.
//
// object URL lifecycle: before every page change, the previous image is always
// `URL.revokeObjectURL()`d first (see `showImage()`), and `dispose()` also does one final
// revoke - no orphaned object URLs are left holding memory.
import type { PreviewPage, PreviewSnapshot } from "./snapshot.ts";
import type { PreviewSource, PreviewSourceError, PreviewSourceStatus } from "./source.ts";
import { formatPreviewSourceError } from "./messages.ts";
import { canGoBack, currentPage, goBack, goTo, initReaderState, restart, type ReaderState } from "./readerState.ts";

/** Mount options - currently just
 * `startPageId` (for the right column's "preview from this page," see the explanation on
 * ./readerState.ts's initReaderState()). Omitting it keeps the existing behavior (starting
 * from the story's `startPageId`). */
export interface MountPreviewReaderOptions {
  readonly startPageId?: string;
}

export interface PreviewReaderHandle {
  readonly element: HTMLElement;
  /** Releases the resources this reader holds while mounted (currently just the illustration's
   * object URL), and calls `source.dispose()` - this reader instance owns the full lifecycle
   * of the PreviewSource it was given at mount time ("dispose when returning
   * to the map" means this whole bundle gets torn down together), so the caller doesn't need
   * to separately remember to dispose the source too. Guaranteed safe to call more than once
   * (any call after the first is a no-op). */
  dispose(): void;
}

function el(tag: string, className?: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const SVG_NS = "http://www.w3.org/2000/svg";

function svgIcon(className: string, innerHtml: string): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", className);
  svg.setAttribute("width", "16");
  svg.setAttribute("height", "16");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2.2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.innerHTML = innerHtml;
  return svg;
}

/** The right-side arrow for a choice/next-page button. */
function arrowIcon(): SVGSVGElement {
  return svgIcon("pv-icon", '<path d="M5 12h14M13 6l6 6-6 6"/>');
}

/** The left-side arrow for "previous page." */
function backIcon(): SVGSVGElement {
  return svgIcon("pv-icon", '<path d="M19 12H5M11 18l-6-6 6-6"/>');
}

/** The loop arrow for "back to the beginning." */
function restartIcon(): SVGSVGElement {
  return svgIcon("pv-icon", '<path d="M3 12a9 9 0 1 0 9-9"/><path d="M3 4v8h8"/>');
}

export function mountPreviewReader(source: PreviewSource, options: MountPreviewReaderOptions = {}): PreviewReaderHandle {
  const root = el("div", "pv-root");
  // The top bar - an immersive layout (per the reader's wide-screen/phone-size design): a
  // progress-dot grid + a "Page N of M" label, with no story title (this component is mounted
  // both in the creator's local preview and in the standalone preview.html phone side, and
  // neither needs the title repeated in the top bar - on the phone side, the first thing seen
  // is the illustration itself).
  const topbar = el("div", "pv-topbar");
  const progressWrap = el("div", "pv-progress-wrap");
  const progressLabel = el("p", "pv-progress-label");
  const progressDots = el("div", "pv-progress-dots");
  progressWrap.appendChild(progressLabel);
  progressWrap.appendChild(progressDots);
  topbar.appendChild(progressWrap);
  const body = el("div", "pv-body");
  root.appendChild(topbar);
  root.appendChild(body);

  let disposed = false;
  let snapshot: PreviewSnapshot | undefined;
  let readerState: ReaderState | undefined;
  let currentImageUrl: string | undefined;
  let imageRequestToken = 0;

  function revokeImage(): void {
    if (currentImageUrl !== undefined) {
      URL.revokeObjectURL(currentImageUrl);
      currentImageUrl = undefined;
    }
  }

  // RelaySource's load() passes through several stages - connecting / waiting for
  // the creator to approve pairing / transferring (see the PreviewSourceStatus header in
  // ./source.ts) - and stays unresolved the whole time; loadingEl keeps a reference to the <p>
  // shown during that stretch, so #statusCallback can update the text in place instead of
  // rebuilding the whole DOM. LocalSource has no such multi-stage process (it never calls the
  // callback registered via source.onStatus), so in that case loadingEl is only ever set once
  // and never updated by describeStatus().
  let loadingEl: HTMLParagraphElement | undefined;

  function renderLoading(text = "Loading..."): void {
    const p = el("p", "pv-loading", text) as HTMLParagraphElement;
    loadingEl = p;
    body.replaceChildren(p);
  }

  function describeStatus(status: PreviewSourceStatus): string {
    switch (status.kind) {
      case "connecting":
        return "Connecting...";
      case "awaiting-approval":
        return `Ask the creator to confirm the pairing code ${status.pairingCode}`;
      case "receiving":
        return "Loading...";
    }
  }

  function renderError(error: PreviewSourceError): void {
    body.replaceChildren(el("p", "pv-error", formatPreviewSourceError(error)));
  }

  async function showImage(imgEl: HTMLImageElement, wrap: HTMLElement, page: PreviewPage): Promise<void> {
    // The generation token must increment before **any** early
    // return - even when the page change lands on "this page has no illustration," any old
    // page's image request still in flight must be made stale. Previously it didn't increment
    // before the early return, so when a stale request arrived late, the staleness check
    // `token !== imageRequestToken` would wrongly conclude "still the latest one" (because
    // nothing had ever touched imageRequestToken), and stuff the old page's image into a
    // current page that plainly has no illustration.
    const token = ++imageRequestToken;
    revokeImage();
    imgEl.removeAttribute("src");
    wrap.hidden = page.imageId === undefined;
    if (page.imageId === undefined) return;

    const meta = snapshot?.images.find((m) => m.id === page.imageId);
    const bytes = await source.image(page.imageId);
    if (disposed || token !== imageRequestToken) return; // A stale image load (the user already turned the page, or the component unmounted) - silently discard
    if (!bytes) return; // Not found - keep the blank placeholder, never fabricate an image (the same existing precedent as ../map/render.ts's loadThumbnail)

    // The Blob constructor (lib.dom.d.ts, TS 5.7+) only accepts an `ArrayBufferView<ArrayBuffer>`
    // - source.image()'s return type is `Uint8Array<ArrayBufferLike>` (which doesn't rule out
    // SharedArrayBuffer); `new Uint8Array(bytes)` copies out a fresh copy guaranteed to be
    // backed by a plain ArrayBuffer, not a cast that bypasses the type check.
    const blob = new Blob([new Uint8Array(bytes)], { type: meta?.mime ?? "image/png" });
    currentImageUrl = URL.createObjectURL(blob);
    imgEl.src = currentImageUrl;
  }

  /** The progress-dot grid - `readerState.path.length` is how many pages this reading session
   * has walked through so far (including the current page); `snapshot.story.pages.length` is
   * how many page nodes this story has in total. A branching story isn't necessarily walked
   * through to that total every time (some pages this reading path will never visit), so this
   * is deliberately only a "sense of scale" visual cue, not a precise linear progress bar -
   * matching how the design already presents it (the dots themselves only distinguish three
   * states, walked/current/not-yet, and are not a guarantee of a linearly reachable path). */
  function renderProgress(): void {
    if (!snapshot || !readerState) return;
    const total = snapshot.story.pages.length;
    const current = Math.min(readerState.path.length, total);
    progressLabel.textContent = `Page ${current} of ${total}`;
    progressDots.replaceChildren();
    for (let i = 1; i <= total; i++) {
      const dotClass = i === current ? "pv-dot pv-dot-now" : i < current ? "pv-dot pv-dot-done" : "pv-dot";
      progressDots.appendChild(el("span", dotClass));
    }
  }

  function renderPage(): void {
    if (!snapshot || !readerState) return;
    const page = currentPage(readerState, snapshot.story);
    if (!page) {
      // Defensive: buildPreviewSnapshot() already guarantees every next/choices target exists
      // in story.pages (see "Defensive" notes in that file), so in theory this is
      // unreachable - fail-closed and show the same fixed message as invalid-story, rather
      // than leaving the screen blank or throwing.
      renderError({ type: "invalid-story" });
      return;
    }
    renderProgress();

    const pageEl = el("div", "pv-page");
    const illustration = el("div", "pv-illustration");
    const img = document.createElement("img");
    img.alt = "Illustration";
    illustration.appendChild(img);
    void showImage(img, illustration, page);
    pageEl.appendChild(illustration);

    const isEnding = page.choices.length === 0 && page.next === undefined;
    const textpane = el("div", "pv-textpane");
    const inner = el("div", `pv-textpane-inner${isEnding ? " pv-textpane-ending" : ""}`);
    textpane.appendChild(inner);
    pageEl.appendChild(textpane);

    const prevButton = el("button", isEnding ? "pv-btn pv-btn-ghost" : "pv-prev-btn", "") as HTMLButtonElement;
    prevButton.type = "button";
    prevButton.hidden = !canGoBack(readerState);
    prevButton.appendChild(backIcon());
    prevButton.appendChild(document.createTextNode("Previous page"));
    prevButton.addEventListener("click", () => {
      if (!readerState) return;
      readerState = goBack(readerState);
      renderPage();
    });

    if (isEnding) {
      inner.appendChild(el("p", "pv-text pv-text-ending", page.text));
      const actions = el("div", "pv-actions");
      const restartButton = el("button", "pv-btn pv-btn-primary", "") as HTMLButtonElement;
      restartButton.type = "button";
      restartButton.appendChild(restartIcon());
      restartButton.appendChild(document.createTextNode("The End · Back to the beginning"));
      restartButton.addEventListener("click", () => {
        if (!snapshot) return;
        readerState = restart(snapshot.story);
        renderPage();
      });
      actions.appendChild(restartButton);
      actions.appendChild(prevButton);
      inner.appendChild(actions);
    } else {
      inner.appendChild(el("p", "pv-text", page.text));

      if (page.choices.length > 0) {
        inner.appendChild(el("p", "pv-choices-head", "What do you want to do?"));
        const choicesWrap = el("div", "pv-choices");
        for (const choice of page.choices) {
          const button = el("button", "pv-btn pv-choice-btn", "") as HTMLButtonElement;
          button.type = "button";
          button.appendChild(document.createTextNode(choice.label));
          button.appendChild(arrowIcon());
          button.addEventListener("click", () => {
            if (!readerState) return;
            readerState = goTo(readerState, choice.target);
            renderPage();
          });
          choicesWrap.appendChild(button);
        }
        inner.appendChild(choicesWrap);
      } else if (page.next !== undefined) {
        const nextTarget = page.next;
        const nextButton = el("button", "pv-btn pv-choice-btn", "") as HTMLButtonElement;
        nextButton.type = "button";
        nextButton.appendChild(document.createTextNode("Next page"));
        nextButton.appendChild(arrowIcon());
        nextButton.addEventListener("click", () => {
          if (!readerState) return;
          readerState = goTo(readerState, nextTarget);
          renderPage();
        });
        inner.appendChild(nextButton);
      }

      const bottomRow = el("div", "pv-bottom-row");
      bottomRow.appendChild(prevButton);
      inner.appendChild(bottomRow);
    }

    body.replaceChildren(pageEl);
  }

  async function init(): Promise<void> {
    renderLoading();
    // Registered before load() is called - load() may emit its first status right
    // at the start internally (RelaySource sends "connecting" the moment it enters
    // #connect()), and registering late would miss it. LocalSource has no onStatus method (it's
    // optional on the interface), so this whole block is a no-op for it.
    source.onStatus?.((status) => {
      if (disposed) return;
      if (loadingEl) loadingEl.textContent = describeStatus(status);
    });
    // `source.load()` is this component's only data entry point, and
    // the PreviewSource implementation it calls may throw directly (instead of returning a
    // structured `ok:false`) - e.g. IndexedDB's behavior under quota exhaustion / private
    // browsing varies by browser, and some cases are a synchronous/asynchronous exception
    // rather than a clean rejection. `LocalSource.load()`/`image()` already collapse the known
    // storage exceptions into `unavailable` themselves (see ./localSource.ts); this is a second
    // line of defense: any exception not caught by that layer should never leave the screen
    // stuck on "Loading..." forever, and instead shows the same fixed message as unavailable.
    let result: Awaited<ReturnType<PreviewSource["load"]>>;
    try {
      result = await source.load();
    } catch {
      if (disposed) return;
      renderError({ type: "unavailable" });
      return;
    }
    if (disposed) return;
    if (!result.ok) {
      snapshot = undefined;
      renderError(result.error);
      return;
    }
    snapshot = result.snapshot;
    readerState = initReaderState(snapshot.story, options.startPageId);
    renderPage();
  }

  void init();

  return {
    element: root,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      revokeImage();
      source.dispose();
    },
  };
}
