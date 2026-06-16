// Decoded key-proxy — a Cloudflare Worker that lets the published extension use
// AI without every user supplying their own API key.
//
// How it works: the extension points each provider SDK's base URL at this
// Worker (e.g. https://<worker>.workers.dev/openrouter) and sends the PUBLIC
// app token instead of a real key. The Worker verifies the app token, swaps it
// for the real provider key (kept as a Worker secret, never shipped), and
// forwards the request upstream — streaming the response straight back.
//
// The app token is only a soft gate (it ships inside the extension). Real
// protection comes from Cloudflare rate limiting + defaulting users to free
// models, so a leaked proxy URL can't run up a real bill. See README.md.

export interface Env {
  // Public, non-secret gate that must match the extension's hosted.appToken.
  DECODED_APP_TOKEN: string;
  // Real provider keys — set with `wrangler secret put <NAME>`.
  OPENAI_API_KEY: string;
  OPENROUTER_API_KEY: string;
  ANTHROPIC_API_KEY: string;
  GEMINI_API_KEY: string;
}

type AuthStyle = "bearer" | "x-api-key" | "x-goog-api-key";

interface Route {
  upstream: string;
  secret: keyof Env;
  auth: AuthStyle;
}

// Path prefix -> where to forward and which credential to inject.
const ROUTES: Record<string, Route> = {
  openai: {
    upstream: "https://api.openai.com/v1",
    secret: "OPENAI_API_KEY",
    auth: "bearer",
  },
  openrouter: {
    upstream: "https://openrouter.ai/api/v1",
    secret: "OPENROUTER_API_KEY",
    auth: "bearer",
  },
  anthropic: {
    upstream: "https://api.anthropic.com",
    secret: "ANTHROPIC_API_KEY",
    auth: "x-api-key",
  },
  gemini: {
    upstream: "https://generativelanguage.googleapis.com",
    secret: "GEMINI_API_KEY",
    auth: "x-goog-api-key",
  },
};

function unauthorized(message: string): Response {
  return new Response(JSON.stringify({ error: { message } }), {
    status: 401,
    headers: { "content-type": "application/json" },
  });
}

// Pulls the token the client sent, however the provider's SDK carries it.
function clientToken(req: Request, url: URL, auth: AuthStyle): string | null {
  if (auth === "bearer") {
    const h = req.headers.get("authorization") ?? "";
    return h.toLowerCase().startsWith("bearer ") ? h.slice(7).trim() : null;
  }
  if (auth === "x-api-key") {
    return req.headers.get("x-api-key");
  }
  // x-goog-api-key — Gemini may also pass it as a ?key= query param.
  return req.headers.get("x-goog-api-key") ?? url.searchParams.get("key");
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    // First path segment selects the provider, e.g. /openrouter/chat/completions.
    const [, prefix, ...rest] = url.pathname.split("/");
    const route = ROUTES[prefix];

    if (!route) {
      return new Response(
        JSON.stringify({ error: { message: `Unknown route: /${prefix}` } }),
        { status: 404, headers: { "content-type": "application/json" } }
      );
    }

    // Verify the public app token before doing anything else.
    const presented = clientToken(request, url, route.auth);
    if (!presented || presented !== env.DECODED_APP_TOKEN) {
      return unauthorized("Decoded proxy: invalid or missing app token.");
    }

    const realKey = env[route.secret];
    if (!realKey) {
      return unauthorized(
        `Decoded proxy: ${route.secret} is not configured on the server.`
      );
    }

    // Rebuild the upstream URL: base + the path after the provider prefix.
    const upstreamUrl = new URL(route.upstream + "/" + rest.join("/"));
    upstreamUrl.search = url.search;
    upstreamUrl.searchParams.delete("key"); // never forward the client's key param

    // Copy headers, drop the client's auth, inject the real provider key.
    const headers = new Headers(request.headers);
    headers.delete("host");
    headers.delete("authorization");
    headers.delete("x-api-key");
    headers.delete("x-goog-api-key");
    if (route.auth === "bearer") {
      headers.set("authorization", `Bearer ${realKey}`);
    } else if (route.auth === "x-api-key") {
      headers.set("x-api-key", realKey);
    } else {
      headers.set("x-goog-api-key", realKey);
    }

    const upstream = new Request(upstreamUrl.toString(), {
      method: request.method,
      headers,
      body:
        request.method === "GET" || request.method === "HEAD"
          ? undefined
          : request.body,
      redirect: "follow",
    });

    // Pass the response straight through — preserves SSE streaming and the
    // upstream status code, so the SDKs' own error handling still works.
    return fetch(upstream);
  },
};
