// A standalone implementation of hash-chain credential verification -- mirrors
// generateHostKey()/deriveViewerToken()/deriveSid() from ../../src/preview/protocol.ts (see that
// file's "credential design" section for the full rationale). relay only does a type-only import of
// protocol.ts, so the function bodies (values) can't cross over -- this file reimplements the same
// hash chain here. The relay side only ever needs the "verify" direction (given a hostKey/token,
// compute the matching sid); it doesn't need generateHostKey() (generating a hostKey is the
// creator-side tab's job -- the relay never generates a hostKey of its own).
//
// Consistency is partially covered by ../test/protocol-parity.test.ts (comparing constants), but
// the hashing algorithm itself (the base64url encoding rules, the utf8 -> sha256 -> hex/base64url
// ordering) can't be covered by a "values are equal" constant comparison alone. A different path
// closes that gap instead: ../test/ws-helpers.ts's generateCredentials() does a value-import of
// generateHostKey()/deriveViewerToken()/deriveSid() straight from
// ../../src/preview/protocol.ts (protocol.ts's authoritative implementation) to produce a test
// (hostKey, viewerToken, sid) triple, and relay/test/session-do.test.ts's happy-path test then has
// SessionDO (verifying with this file's own independent implementation) accept that credential --
// if protocol.ts's "generate" implementation and this file's "verify" implementation ever diverge
// in their understanding of the hashing algorithm, the happy-path test fails immediately, instead
// of only surfacing once the web app wires up RelaySource.

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sha256Utf8ToBase64Url(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return base64UrlEncode(new Uint8Array(digest));
}

async function sha256Utf8ToHex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** viewerToken -> sid. Used to verify a viewer hello's token. */
export async function sidFromViewerToken(token: string): Promise<string> {
  return sha256Utf8ToHex(token);
}

/** hostKey -> viewerToken -> sid. Used to verify a host hello's hostKey -- computes one extra
 * layer, using viewerToken as an intermediate value; this is the same chain as protocol.ts's two
 * steps deriveViewerToken()+deriveSid(). */
export async function sidFromHostKey(hostKey: string): Promise<string> {
  const viewerToken = await sha256Utf8ToBase64Url(hostKey);
  return sha256Utf8ToHex(viewerToken);
}
