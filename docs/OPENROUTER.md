# OpenRouter free models

Optional path for `inference.chat` and `inference.generate`. Omit `provider`, or set it to `ollama`, and the daemon keeps using local Ollama. Set `provider` to `openrouter` to call OpenRouter. The provider does nothing unless `OPENROUTER_API_KEY` is set in the daemon environment.

The key is read at call time. It is never written to logs, receipts, metrics, or error text.

## Setup

1. Create an OpenRouter API key. Optional: set a per-key credit limit of 0 so the key cannot spend money.
2. Store the key in the project vault. Export it as `OPENROUTER_API_KEY` for the daemon process (shell environment or a systemd-user drop-in). Restart the daemon.
3. Leave the account setting that allows training on free-model prompts off. Default mode does not need that setting.
4. Call `inference.chat` or `inference.generate` with `provider` set to `openrouter`.

## Allowlist

Enforcement is allowlist-only. A model id that is not listed is refused before any network call. The response `model` must be the requested id or that id's pinned canonical slug, with or without `:free`. Anything else is discarded and not returned to the caller.

| Id | Canonical slug | Tier | May train |
|---|---|---|---|
| `google/gemma-4-31b-it:free` | `google/gemma-4-31b-it-20260402` | default | no |
| `google/gemma-4-26b-a4b-it:free` | `google/gemma-4-26b-a4b-it-20260403` | default | no |
| `nvidia/nemotron-3-super-120b-a12b:free` | `nvidia/nemotron-3-super-120b-a12b-20230311` | training | yes |
| `nvidia/nemotron-3.5-lightning:free` | `nvidia/nemotron-3.5-lightning-20260807` | training | yes |
| `nvidia/nemotron-3-ultra-550b-a55b:free` | `nvidia/nemotron-3-ultra-550b-a55b-20260604` | explicit | yes |
| `thinkingmachines/inkling:free` | `thinkingmachines/inkling-20260715` | explicit | yes |
| `thinkingmachines/inkling-small:free` | `thinkingmachines/inkling-small-20260730` | explicit | yes |
| `liquid/lfm-2.5-2.6b:free` | `liquid/lfm-2.5-2.6b-20260811` | explicit | yes |

Reviewed 2026-10-06. The list is static. A stale id fails the request instead of being replaced with an unknown model.

## Default model and chains

Default model: `google/gemma-4-31b-it:free`.

Default chain (`data_collection` `deny`):

1. `google/gemma-4-31b-it:free`
2. `google/gemma-4-26b-a4b-it:free`

Training-allowed chain, only when `REVDEV_OPENROUTER_ALLOW_TRAINING=1` (`data_collection` `allow`):

1. `google/gemma-4-31b-it:free`
2. `nvidia/nemotron-3-super-120b-a12b:free`
3. `nvidia/nemotron-3.5-lightning:free`

Explicit ids are allowlisted and never auto-selected. Name one in `model`, and set `REVDEV_OPENROUTER_ALLOW_TRAINING=1`, or the call is refused. The request chain is the named id followed by the active chain, capped at 3.

`REVDEV_OPENROUTER_MODEL` can replace the default. The value must be allowlisted and permitted in the current mode. A bad value is an error. It is not ignored.

## Privacy modes

Default mode sends `provider.data_collection` of `deny`. OpenRouter then uses only endpoints that do not train on prompts. The default chain is the two ids above. They share one route, so an outage or a rate limit on that route fails the call instead of moving to an endpoint that may train.

Training-allowed mode (`REVDEV_OPENROUTER_ALLOW_TRAINING=1`) sends `data_collection` of `allow`. Prompts may be retained and used for training by the endpoint. This mode also needs the OpenRouter account toggle that allows providers which may train on free-model prompts. Leave that toggle off unless you want this mode.

OpenRouter stores metadata such as token counts and latency. It does not store prompt text unless that account option is turned on.

Some no-train endpoints still retain prompts for a limited time. Default mode avoids training. It does not promise zero retention.

## Limits

Free models are capped at 20 requests per minute. The daily cap is 50 requests if less than 10 USD of credits were ever purchased, and 1000 requests per day once 10 USD or more has been purchased. A negative balance can return HTTP 402 even for a free model.

On HTTP 429 the daemon returns `rateLimited: true` and the `Retry-After` / `X-RateLimit-*` fields when they are present. It retries at most once, and only when `Retry-After` is 5 seconds or less.

## `openrouter/free`

Leave this off.

`openrouter/free` picks a free model at random. The prompt is sent before revdev can see which model answered. Enabling it violates the US-only lock. A later check can discard a non-allowlisted answer, but the prompt has already left.

The id is never part of a default chain. It is accepted only when both of these are true:

- `REVDEV_OPENROUTER_ALLOW_FREE_ROUTER=1`
- the request sets `model` to `openrouter/free`

The response-model allowlist check still runs. Receipts set `freeRouter` to true.

## Environment

| Var | Default | Meaning |
|---|---|---|
| `OPENROUTER_API_KEY` | unset | Enables the provider. Never commit or log it. |
| `REVDEV_OPENROUTER_MODEL` | `google/gemma-4-31b-it:free` | Default model. Must be allowlisted. |
| `REVDEV_OPENROUTER_ALLOW_TRAINING` | `0` | `1` allows training-tier and explicit ids and sends `data_collection: allow`. |
| `REVDEV_OPENROUTER_ALLOW_FREE_ROUTER` | `0` | `1` permits an explicit `openrouter/free` request. Violates the US-only lock. |
| `REVDEV_OPENROUTER_REFERER` | `https://revealui.com` | `HTTP-Referer`. |
| `REVDEV_OPENROUTER_TITLE` | `RevDev` | `X-OpenRouter-Title` and `X-Title`. |
| `REVDEV_OPENROUTER_PUBLIC_APP` | `0` | `1` drops the hidden app-visibility header. |
| `REVDEV_OPENROUTER_CHAT_TIMEOUT_MS` | `120000` | Per-call timeout. |

## Receipts

Every OpenRouter call writes a best-effort `inference.receipt` row. The payload has provider, method, requested chain, model id, origin, status, HTTP status, token counts, latency, data-collection mode, and `freeRouter`. It does not contain prompt text, response text, headers, or the key.

`events.query` is Pro tier:

```json
{"jsonrpc":"2.0","id":1,"method":"events.query","params":{"eventType":"inference.receipt","limit":20}}
```

## Example

```json
{"jsonrpc":"2.0","id":1,"method":"inference.chat","params":{"provider":"openrouter","messages":[{"role":"user","content":"Reply with ok."}]}}
```

`inference.generate` with the same provider maps `prompt` (and optional `system`) to chat messages and returns `response`.
