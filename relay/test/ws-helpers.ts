// Small test helpers: wrap WebSocket's event-based API (addEventListener("message"/"close")) as a
// Promise, so test assertions can be written directly. Test-only -- not part of the relay's own
// code.
//
// generateCredentials() does a direct value-import (not type-only) of the credential-derivation
// functions in ../../src/preview/protocol.ts -- the "protocol.ts can only be type-only imported"
// boundary applies to relay/src/**'s source tree (see the "boundary decision on file location" note
// in that file's header, and the header of ../src/crypto.ts), and test code isn't bound by that
// boundary; using protocol.ts's authoritative implementation directly to produce test credentials
// also verifies the two sides' implementations actually agree far better than cobbling together
// another copy of the hashing logic inside the tests (see the note in ../src/crypto.ts's header).
import type { SessionDO } from "../src/session-do.ts";
import { deriveSid, deriveViewerToken, generateHostKey } from "../../src/preview/protocol.ts";

export interface Credentials {
  readonly hostKey: string;
  readonly viewerToken: string;
  readonly sid: string;
}

/** Produces a (hostKey, viewerToken, sid) triple -- simulates the real flow of "the creator side
 * computes a credential once; the host connects with hostKey and the viewer connects with
 * viewerToken, and each side computes the same sid on its own". */
export async function generateCredentials(): Promise<Credentials> {
  const hostKey = generateHostKey();
  const viewerToken = await deriveViewerToken(hostKey);
  const sid = await deriveSid(viewerToken);
  return { hostKey, viewerToken, sid };
}

export function nextMessage(ws: WebSocket): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const onMessage = (event: MessageEvent) => {
      cleanup();
      if (typeof event.data !== "string") {
        reject(new Error("expected a text frame"));
        return;
      }
      resolve(JSON.parse(event.data));
    };
    const onClose = (event: CloseEvent) => {
      cleanup();
      reject(new Error(`socket closed before a message arrived (code=${event.code} reason=${event.reason})`));
    };
    function cleanup() {
      ws.removeEventListener("message", onMessage);
      ws.removeEventListener("close", onClose);
    }
    ws.addEventListener("message", onMessage);
    ws.addEventListener("close", onClose);
  });
}

export interface CloseInfo {
  readonly code: number;
  readonly reason: string;
}

export function nextClose(ws: WebSocket): Promise<CloseInfo> {
  return new Promise((resolve) => {
    ws.addEventListener("close", (event: CloseEvent) => {
      resolve({ code: event.code, reason: event.reason });
    });
  });
}

/** Opens a WebSocket to a given DO stub, calls accept() on it, and returns a client-side WebSocket
 * ready for direct send/receive. sid is required -- SessionDO.fetch() now reads sid directly from
 * the forwarded request URL (see ../src/session-do.ts), it's no longer an optional parameter. */
export async function openSocket(stub: DurableObjectStub<SessionDO>, sid: string): Promise<WebSocket> {
  const res = await stub.fetch(`http://do/session?sid=${sid}`, { headers: { Upgrade: "websocket" } });
  const ws = res.webSocket;
  if (!ws) throw new Error("expected a 101 response carrying a WebSocket");
  ws.accept();
  return ws;
}

export function send(ws: WebSocket, message: unknown): void {
  ws.send(JSON.stringify(message));
}
