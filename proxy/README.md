# Decoded key-proxy

A tiny [Cloudflare Worker](https://workers.cloudflare.com/) that lets the published **Decoded**
extension call AI providers **without each user supplying their own API key**.

The extension points each provider's SDK base URL at this Worker and sends a public *app token*
instead of a real key. The Worker checks the app token, swaps it for the real provider key (stored
as an encrypted Worker secret, never shipped in the extension), and forwards the request upstream —
streaming the response straight back.

## Routes

| Path prefix   | Forwards to                                      | Injects secret        |
| ------------- | ------------------------------------------------ | --------------------- |
| `/openai`     | `https://api.openai.com/v1`                      | `OPENAI_API_KEY`      |
| `/openrouter` | `https://openrouter.ai/api/v1`                   | `OPENROUTER_API_KEY`  |
| `/anthropic`  | `https://api.anthropic.com`                      | `ANTHROPIC_API_KEY`   |
| `/gemini`     | `https://generativelanguage.googleapis.com`      | `GEMINI_API_KEY`      |

## Deploy

```bash
cd proxy
npm install
npx wrangler login                       # opens a browser, one-time
npx wrangler secret put OPENAI_API_KEY   # paste the key at the hidden prompt
npx wrangler secret put OPENROUTER_API_KEY
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put GEMINI_API_KEY
npx wrangler deploy                      # prints your https://<name>.<subdomain>.workers.dev URL
```

Put the printed URL into the extension at `src/hosted.ts` (`proxyUrl`).

## Security notes

- `DECODED_APP_TOKEN` (in `wrangler.toml`) is a **soft gate only** — it ships inside the public
  extension, so anyone can read it. It stops casual misuse, not a determined attacker.
- Real protection: add a **Cloudflare rate-limiting / WAF rule** on the Worker, and keep users
  defaulted to **free models** (OpenRouter `*:free`, Gemini free tier) so a leaked proxy URL can't
  run up a real bill. The paid OpenAI path is best left to users who bring their own key.
- To rotate the gate, change `DECODED_APP_TOKEN` here **and** `appToken` in `src/hosted.ts`, then
  redeploy the Worker and republish the extension.
- The real provider keys live only in Worker secrets. Rotate them anytime with `wrangler secret put`
  — no extension update needed.
