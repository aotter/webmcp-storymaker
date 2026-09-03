// Worker entry point: routing (/session, /health) + outward-facing access control (Origin check) +
// forwarding /session's WebSocket upgrade to the right SessionDO instance. This file contains no
// session state or protocol logic at all -- that all lives in ./session-do.ts; this file is only
// responsible for "where should this request go" and "should this request be let in".
//
// The design rationale for DO routing and sid is written out in full in the "technical constraints
// and countermeasures for DO routing" and "credential design" sections of
// ../../src/preview/protocol.ts's header -- here we only repeat the single most important line:
// `sid` is `deriveSid(viewerToken)` (the host side first derives viewerToken from hostKey, then
// computes it; the viewer side computes it directly), computed by the caller (the creator-side or
// mobile-reader-side page) using the browser's native Web Crypto, and placed in the query string of
// `/session?sid=...`; it's a public identifier used for routing, not the credential itself --
// hostKey/viewerToken in plaintext only ever appear in the first message (hello) after the
// WebSocket connection is established.
//
// The way Origin access control is implemented differs from typical CORS in a way worth explaining:
// /health is a plain HTTP GET, so it can use the standard Access-Control-Allow-Origin response
// header (the browser itself blocks cross-origin JS from reading it). But /session is a WebSocket
// handshake -- the browser's same-origin policy does **not** restrict a page from opening a
// cross-origin WebSocket connection, and CORS headers have no effect at all on a WebSocket
// handshake. So the only viable access control for /session is for the server itself to read the
// `Origin` request header and compare it directly against env.ALLOWED_ORIGIN, rejecting with a
// plain HTTP 4xx before the upgrade if it doesn't match (no WebSocket is ever established, no DO is
// ever entered).

// Env is the global environment type from worker-configuration.d.ts, see the note at the end of
// ./session-do.ts.
import { SessionDO } from "./session-do.ts";
import { SID_PATTERN } from "./protocol-limits.ts";

export { SessionDO };

const HEALTH_BODY = JSON.stringify({ status: "ok", service: "webmcp-storymaker-preview-relay" });

function corsHeadersFor(request: Request, env: Env): HeadersInit {
  const origin = request.headers.get("Origin");
  if (origin && origin === env.ALLOWED_ORIGIN) {
    return { "Access-Control-Allow-Origin": origin, Vary: "Origin" };
  }
  return { Vary: "Origin" };
}

function handleHealth(request: Request, env: Env): Response {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeadersFor(request, env) });
  }
  if (request.method !== "GET") {
    return new Response("Method Not Allowed", { status: 405 });
  }
  return new Response(HEALTH_BODY, {
    status: 200,
    headers: { "Content-Type": "application/json", ...corsHeadersFor(request, env) },
  });
}

function handleSession(request: Request, env: Env): Response | Promise<Response> {
  // A WebSocket handshake doesn't respond to CORS headers (see the file header) -- access control
  // compares Origin directly, and rejects before the upgrade if it doesn't match, without
  // establishing any connection.
  const origin = request.headers.get("Origin");
  if (origin !== env.ALLOWED_ORIGIN) {
    return new Response("Forbidden origin", { status: 403 });
  }

  if ((request.headers.get("Upgrade") ?? "").toLowerCase() !== "websocket") {
    return new Response("Expected Upgrade: websocket", { status: 426 });
  }

  const sid = new URL(request.url).searchParams.get("sid");
  if (!sid || !SID_PATTERN.test(sid)) {
    // Not even shaped like a valid routing identifier -- there's no DO this could ever belong to,
    // so complete the WebSocket handshake right here at this layer, send an invalid-token error,
    // and close, without disturbing any DO.
    return rejectAsInvalidToken();
  }

  const stub = env.SESSION.getByName(sid);
  return stub.fetch(request);
}

function rejectAsInvalidToken(): Response {
  const pair = new WebSocketPair();
  const [client, server] = Object.values(pair);
  server.accept();
  try {
    server.send(JSON.stringify({ type: "error", code: "invalid-token" }));
  } catch {
    // If it can't be sent, never mind -- it's about to be closed anyway.
  }
  try {
    server.close(4004, "invalid-token");
  } catch {
    // Already closing.
  }
  return new Response(null, { status: 101, webSocket: client });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return handleHealth(request, env);
    }
    if (url.pathname === "/session") {
      return handleSession(request, env);
    }
    return new Response("Not Found", { status: 404 });
  },
};
