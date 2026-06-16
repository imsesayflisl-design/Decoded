// Hosted ("no key needed") mode. When the user hasn't set their own API key,
// Decoded routes provider calls through a small proxy that holds the real keys
// server-side, so a fresh install just works without prompting for a key.
//
// IMPORTANT: nothing here is secret. `appToken` is only a soft gate that ships
// inside the published extension; the real provider keys live as secrets on the
// proxy (see proxy/README.md). Safe to commit and ship.

export interface HostedConfig {
  // Master switch. If false, Decoded falls back to prompting for a user key.
  enabled: boolean;
  // The deployed Cloudflare Worker base URL (no trailing slash), e.g.
  // "https://decoded-proxy.<your-subdomain>.workers.dev". Set after deploying.
  proxyUrl: string;
  // Public gate that must match the Worker's DECODED_APP_TOKEN (proxy/wrangler.toml).
  appToken: string;
}

export const HOSTED: HostedConfig = {
  // Flip to true once proxyUrl points at a deployed Worker.
  enabled: false,
  proxyUrl: "https://decoded-proxy.example.workers.dev",
  appToken: "decoded-public-v1",
};

// The proxy route for a given provider, e.g. ".../openrouter".
export function hostedBaseUrl(providerId: string): string {
  return `${HOSTED.proxyUrl.replace(/\/+$/, "")}/${providerId}`;
}
