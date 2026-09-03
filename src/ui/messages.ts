// Maps the story layer's result-union errors to
// plain-English messages a parent can read -- the existing hard rule "every result-union error must
// be mapped to a message a parent can read, never console-only". This file only does the mapping
// (a pure function, zero DOM, zero state); ./controller.ts is its only caller.
//
// This screen has no local write path (../webmcp/tools/writeTools.ts is the only writer), so
// there are no error-mapping functions for create-story, page text writes, or archive
// import/export here -- only `formatReadStoryError()` -- hydrate()/
// background reloads need it to translate "the story file is corrupted"/"the workspace is
// busy" into a sentence a parent can understand, shown in the error view.
import type { ReadStoryError } from "../story/index.ts";

export function formatReadStoryError(error: ReadStoryError): string {
  switch (error.type) {
    case "story-not-found":
      return "There's no story yet -- ask your AI assistant to create one first.";
    case "invalid-yaml":
      return `The story file is corrupted and can't be read: ${error.reason}`;
    case "workspace-busy":
      return `The data is changing too fast right now -- please try again in a moment: ${error.reason}`;
  }
}
