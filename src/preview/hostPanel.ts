// Phone-QR-scan preview: the creator's "phone preview" panel - DOM binding, "too thin to be
// worth testing" (the same discipline as the ./reader.ts header and the ../ui/dom.ts header).
//
// This file no longer holds any HostSession instance, and no longer
// decides for itself "when to open/close the connection" - that whole lifecycle has moved into
// ../ui/controller.ts (see the note above the
// HostSession class in ./hostSession.ts). This file is now purely a renderer that "renders
// `EditorState.mobilePreview` and turns user button presses into controller method calls" -
// written the same way as ../map/render.ts's `createMapEditorView()`: mounted once (on
// entering the editor view), and after that redrawn in place on every `update(state)`, never
// mounted/disposed on tab switches (this differs from an older behavior, where the old
// version called `HostSession.dispose()` to close the connection whenever the user left the
// "preview reading" tab; in the current version, switching tabs never affects the session at all).
//
// QR code: uses the zero-dependency qrcode-generator (see package.json, its version is pinned)
// to compute the module (black/white cell) matrix, then hand-assembles an <svg> (DOM API,
// createElementNS one node at a time, never string-concatenating innerHTML - the same
// discipline as "never use innerHTML" in the ../ui/dom.ts header; there's no security concern
// here, since the whole SVG is computed by us from a boolean matrix and never splices in any
// external string, but it still follows the same house rule). No external service/CDN is
// allowed - qrcode-generator computes locally, and makes no network
// requests at all.
import qrcode from "qrcode-generator";
import type { HostSessionState } from "./hostSession.ts";
import type { StoryUiController } from "../ui/controller.ts";
import type { EditorState } from "../ui/state.ts";

const SVG_NS = "http://www.w3.org/2000/svg";

/** Renders `text` (the URL for the phone to scan) as an <svg> QR code - `errorCorrectionLevel`
 * uses "M" (medium error correction, qrcode-generator's recommended default), and `typeNumber`
 * is passed as 0 so the library auto-selects the smallest version that fits (without assuming
 * the URL's length ahead of time). */
function buildQrSvg(text: string): SVGSVGElement {
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();
  const count = qr.getModuleCount();

  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${count} ${count}`);
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", "Phone-scan preview QR code");
  svg.classList.add("ll-mp-qr");

  const background = document.createElementNS(SVG_NS, "rect");
  background.setAttribute("width", String(count));
  background.setAttribute("height", String(count));
  background.setAttribute("fill", "#ffffff");
  svg.appendChild(background);

  let path = "";
  for (let row = 0; row < count; row++) {
    for (let col = 0; col < count; col++) {
      if (qr.isDark(row, col)) path += `M${col},${row}h1v1h-1z`;
    }
  }
  const foreground = document.createElementNS(SVG_NS, "path");
  foreground.setAttribute("d", path);
  foreground.setAttribute("fill", "#000000");
  svg.appendChild(foreground);

  return svg;
}

function el(tag: string, className?: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** phase -> the fixed status copy shown to the creator. When send-blocked/host-offline/relay-error have their own more complete sentence,
 * that sentence is shown instead (see the caller in render()); this is just the fallback for
 * "what this phase itself is called." */
const PHASE_LABEL: Record<HostSessionState["phase"], string> = {
  connecting: "Connecting...",
  "waiting-for-scan": "Waiting for the phone to scan",
  "confirm-pairing": "Waiting for you to confirm pairing",
  transferring: "Paired - the phone is reading",
  sent: "Sent",
  "send-blocked": "Couldn't send",
  "host-offline": "The phone went offline",
  "session-expired": "The preview has expired",
  "relay-error": "The relay connection failed",
  ended: "Ended",
};

export interface MobilePreviewView {
  readonly element: HTMLElement;
  update(state: EditorState): void;
}

function iconWrap(): HTMLElement {
  const icon = el("span", "ll-mp-head-icon");
  icon.innerHTML =
    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="2" width="12" height="20" rx="2.4"/><path d="M10 18h4"/></svg>';
  return icon;
}

function privacyFooter(): HTMLElement {
  const footer = el("div", "ll-mp-footer");
  const icon = document.createElementNS(SVG_NS, "svg");
  icon.setAttribute("width", "13");
  icon.setAttribute("height", "13");
  icon.setAttribute("viewBox", "0 0 24 24");
  icon.setAttribute("fill", "none");
  icon.setAttribute("stroke", "currentColor");
  icon.setAttribute("stroke-width", "2");
  icon.innerHTML = '<rect x="4" y="10" width="16" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>';
  footer.appendChild(icon);
  footer.appendChild(
    el(
      "p",
      undefined,
      "Stories stay on the creator's device. Nothing is persisted to the cloud during preview; it is only relayed over an encrypted connection.",
    ),
  );
  return footer;
}

/** Builds the "copy the phone preview link as text" row shown next to the QR code - it renders
 * the exact same URL the QR encodes (including its `#` fragment) into a read-only, selectable
 * `<input>`, plus a "Copy link" button that uses `navigator.clipboard.writeText()` and flips
 * its own label to "Copied" for about 1.5s. The point is developer/tester convenience: pasting
 * the link straight into a phone simulator's address bar is faster than photographing a QR
 * code off the screen. Kept deliberately separate from the QR code itself - callers only render
 * this alongside the QR (see the `if (state.viewerUrl)` branch in renderSession() below), so it
 * appears and disappears together with the QR when the session ends or the token gets consumed.
 *
 * Styled with inline styles that reuse the existing `--c-*` design tokens (defined in
 * ../ui/style.css, already loaded on this page) instead of adding new CSS classes: this file
 * only owns src/preview/**, not src/ui/style.css (where the rest of this panel's
 * `.ll-mp-*` rules live), and ./reader.css deliberately stays "mount-agnostic" (see its own
 * header) rather than carrying creator-only host-panel styling. Inline styles keep this new
 * bit of UI fully inside this file's own scope without touching either file. */
function buildLinkRow(url: string): HTMLElement {
  const row = el("div");
  row.style.display = "flex";
  row.style.alignItems = "center";
  row.style.gap = "6px";
  row.style.marginTop = "4px";

  const input = document.createElement("input");
  input.type = "text";
  input.readOnly = true;
  input.value = url;
  input.setAttribute("aria-label", "Phone preview link");
  input.style.flex = "1 1 auto";
  input.style.minWidth = "0";
  input.style.font = "inherit";
  input.style.fontSize = "11px";
  input.style.padding = "5px 8px";
  input.style.borderRadius = "var(--radius-sm)";
  input.style.border = "1px solid var(--c-border)";
  input.style.background = "var(--c-surface-alt)";
  input.style.color = "var(--c-ink-muted)";
  // Clicking/focusing the field selects its whole contents, so the link is always selectable
  // by hand even when the Clipboard API below is unavailable (e.g. an insecure context).
  input.addEventListener("focus", () => input.select());

  const copyBtn = el("button", undefined, "Copy link") as HTMLButtonElement;
  copyBtn.type = "button";
  copyBtn.style.flex = "0 0 auto";
  copyBtn.style.padding = "5px 10px";
  copyBtn.style.borderRadius = "var(--radius-pill)";
  copyBtn.style.border = "1px solid var(--c-border-strong)";
  copyBtn.style.background = "var(--c-surface)";
  copyBtn.style.color = "var(--c-ink-muted)";
  copyBtn.style.font = "inherit";
  copyBtn.style.fontSize = "11px";
  copyBtn.style.fontWeight = "700";
  copyBtn.style.cursor = "pointer";

  let resetTimer: ReturnType<typeof setTimeout> | undefined;
  copyBtn.addEventListener("click", () => {
    const clipboard = navigator.clipboard as Clipboard | undefined;
    if (!clipboard?.writeText) {
      // No Clipboard API (e.g. an insecure context, or an older browser) - fall back to
      // selecting the text so the user can still copy it manually with the keyboard shortcut.
      input.focus();
      input.select();
      return;
    }
    clipboard.writeText(url).then(
      () => {
        copyBtn.textContent = "Copied";
        if (resetTimer !== undefined) clearTimeout(resetTimer);
        resetTimer = setTimeout(() => {
          copyBtn.textContent = "Copy link";
        }, 1500);
      },
      () => {
        // The browser denied the clipboard write (e.g. a permissions-policy block) - same
        // fallback as when the API doesn't exist at all.
        input.focus();
        input.select();
      },
    );
  });

  row.appendChild(input);
  row.appendChild(copyBtn);
  return row;
}

/** The content of the "phone preview" tab - a centered card +
 * QR code + pairing code + status pill + pairing-confirmation card + end preview + a footer
 * privacy sentence. Mounted in the editor view (../ui/dom.ts buildEditorMount()), following the
 * same pattern as ../map/render.ts's map view - "built once on entering the editor view, and
 * after that only redrawn in place with update()" - see the file header. */
export function createMobilePreviewView(initial: EditorState, controller: StoryUiController): MobilePreviewView {
  const root = el("div", "ll-mp-panel");

  // Reference equality skips a rebuild (the same throttling trick already used by
  // ../map/render.ts's createMapEditorView()) - this view now keeps getting update()d
  // regardless of which tab the user is currently on, but `state.mobilePreview` only changes
  // reference when there's actually a new HostSession state (selecting a map node, switching
  // tabs, and other actions never touch this field), so there's no need to redraw the QR code
  // every single time.
  let lastSession: EditorState["mobilePreview"] | undefined;

  function renderRelayUnavailable(): void {
    root.replaceChildren();
    const card = el("div", "ll-mp-card");
    card.appendChild(el("p", "ll-notice ll-notice-error", "The relay server address hasn't been configured, so phone preview can't start."));
    root.appendChild(card);
  }

  function renderConnecting(): void {
    root.replaceChildren();
    const card = el("div", "ll-mp-card");
    card.appendChild(el("p", "ll-mp-status", "Connecting..."));
    root.appendChild(card);
  }

  function renderSession(state: HostSessionState): void {
    root.replaceChildren();
    const card = el("div", "ll-mp-card");

    const headRow = el("div", "ll-mp-head-row");
    const headTitle = el("p", "ll-mp-head-title");
    headTitle.appendChild(iconWrap());
    headTitle.appendChild(document.createTextNode("Phone preview"));
    headRow.appendChild(headTitle);
    const end = el("button", "ll-mp-end-btn", "End preview") as HTMLButtonElement;
    end.type = "button";
    end.addEventListener("click", () => controller.endMobilePreview());
    headRow.appendChild(end);
    card.appendChild(headRow);

    if (state.errorMessage) {
      card.appendChild(el("p", "ll-notice ll-notice-error", state.errorMessage));
    }

    if (state.phase === "waiting-for-scan" || state.phase === "confirm-pairing" || state.phase === "transferring" || state.phase === "sent") {
      const scanBlock = el("div", "ll-mp-scan-block");
      if (state.viewerUrl) {
        const qrWrap = el("div", "ll-mp-qr-wrap");
        qrWrap.appendChild(buildQrSvg(state.viewerUrl));
        scanBlock.appendChild(qrWrap);
      }
      const info = el("div", "ll-mp-scan-info");
      const statusPill = el("p", "ll-mp-status");
      statusPill.appendChild(el("span", "ll-mp-status-dot"));
      statusPill.appendChild(document.createTextNode(PHASE_LABEL[state.phase]));
      info.appendChild(statusPill);
      if (state.pairingCode) {
        info.appendChild(el("p", "ll-mp-code-label", "Pairing code"));
        info.appendChild(el("p", "ll-mp-code", state.pairingCode));
      }
      info.appendChild(el("p", "ll-mp-caption", "Scan this QR code in the phone's browser, or type in the pairing code by hand."));
      if (state.viewerUrl) info.appendChild(buildLinkRow(state.viewerUrl));
      scanBlock.appendChild(info);
      card.appendChild(scanBlock);
    } else {
      card.appendChild(el("p", "ll-mp-status", PHASE_LABEL[state.phase]));
    }

    if (state.phase === "confirm-pairing" && state.pairingCode) {
      const confirmCard = el("div", "ll-mp-confirm-card");
      confirmCard.appendChild(el("p", "ll-mp-confirm-text", `Does the phone show the pairing code ${state.pairingCode}?`));
      const actions = el("div", "ll-mp-actions");
      const approve = el("button", "ll-mp-btn ll-mp-btn-approve", "Approve") as HTMLButtonElement;
      approve.type = "button";
      approve.addEventListener("click", () => controller.approveMobilePairing());
      actions.appendChild(approve);
      const reject = el("button", "ll-mp-btn ll-mp-btn-reject", "Reject") as HTMLButtonElement;
      reject.type = "button";
      reject.addEventListener("click", () => controller.rejectMobilePairing());
      actions.appendChild(reject);
      confirmCard.appendChild(actions);
      card.appendChild(confirmCard);
    }

    card.appendChild(privacyFooter());
    root.appendChild(card);
  }

  function applyState(state: EditorState): void {
    if (!controller.mobileRelayAvailable) {
      if (lastSession !== null) {
        lastSession = null;
        renderRelayUnavailable();
      }
      return;
    }
    if (state.mobilePreview === lastSession) return; // No new session state - skip the redraw
    lastSession = state.mobilePreview;
    if (state.mobilePreview === null) {
      // In theory, the moment the user switches to the "phone preview" tab,
      // controller.setActiveTab("mobile") synchronously triggers #startMobilePreview(), and a
      // real HostSessionState arrives on the next tick - this only shows a placeholder during
      // that very brief window; it is not a start button for the user to press manually.
      renderConnecting();
      return;
    }
    renderSession(state.mobilePreview);
  }

  applyState(initial);

  return { element: root, update: applyState };
}
