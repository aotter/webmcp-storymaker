// The sole public export point for the WebMCP facade -- the composition root
// (app.ts), the production adapter (main.ts), and the WebMCP tool implementations only import
// from here (following the same barrel convention as src/story/index.ts). Deliberately does not
// re-export the native types under ./types.ts like `ModelContext*`/`WebMcpDocument` -- those are
// shapes the facade uses internally to talk to document.modelContext, not the public interface
// meant for callers (see the "don't scatter WebMCP types into the domain/storage layer" note in
// the header of ./types.ts). Only ./facade.ts itself and ../testing/fakeModelContext.ts need
// those native types, and both import ./types.ts directly, not through this barrel.
export type {
  WebMcpPort,
  WebMcpRegistration,
  WebMcpToolAnnotations,
  WebMcpToolDefinition,
  WebMcpToolExecuteOptions,
} from "./types.ts";
export { WebMcpRegistrationError } from "./types.ts";
export { DomWebMcpFacade } from "./facade.ts";
