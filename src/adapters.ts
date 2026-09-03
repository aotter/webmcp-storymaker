// Production adapter, wired up by src/main.ts's createApp().
//
// The production adapter for workspace storage is the real IndexedDB
// implementation (IndexedDbWorkspaceStorage in
// ./adapters/indexeddbWorkspaceStorage.ts).
//
// There used to be a `DomWebMcpCapability` here (which only did
// `document.modelContext` detection) -- removed entirely, replaced by
// `DomWebMcpFacade` in `src/webmcp/facade.ts` (which adds `registerTools()`;
// see that file's header, "port-absorption rationale", for why). `src/main.ts`
// now imports `DomWebMcpFacade` instead.
