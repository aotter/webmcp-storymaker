// The entry point for preview.html - the independent route for the
// phone-QR-scan preview.
//
// Boundary (a hard requirement, mechanically verified by scripts/smoke-build.ts's
// build-artifact scan, not just self-discipline over the import list here): this file only
// imports ./reader.ts (PreviewReader), ./relaySource.ts, and
// whatever types each needs - it does not import anything under ../ui/**, ../webmcp/**,
// ../map/**, ../media/**, ../workspace/**, ../adapters/**. The phone side is a pure-reading,
// preview-only surface: zero editing entry points, zero WebMCP tool registration, and the
// import list here is itself the first line of defense for that promise.
import { mountPreviewReader } from "./reader.ts";
import { RelaySource } from "./relaySource.ts";
import "./reader.css";

const root = document.getElementById("app");
if (root) {
  const reader = mountPreviewReader(new RelaySource());
  root.appendChild(reader.element);
}
