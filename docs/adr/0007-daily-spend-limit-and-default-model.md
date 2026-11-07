# A daily spend limit Hamkey enforces itself, and the default model

The Operator sets a daily limit in US dollars (`HAMKEY_DAILY_LIMIT_USD`, default $1). Once a day's spend reaches it, Hamkey refuses all model work until the server's local midnight, and tells the Member so in plain words. A limit of 0 refuses everything.

Pi Durable keeps running totals in each conversation's `pi.usage`, with failed and aborted attempts included, and `harness.usage()` sums them. It has no daily figure, so Hamkey writes the running total when each day begins to `<dataDir>/spend.json` and takes today's spend as the difference. The file is what lets the day's spend survive a restart. If the total is ever lower than the noted start, for example because the store was replaced, the day starts again from the current total.

The limit is checked in two places:

- **Before a message is queued.** A new message over the limit gets HTTP 429 and the plain message, so the Member keeps their text.
- **Before every model request.** Pi Durable sends every generation and compaction request through the pi-ai provider the host gives it. Hamkey wraps that provider, and over the limit it ends the request with a provider error at once, with no request sent. The run fails, and the Member sees the same plain message. A run that crosses the limit partway therefore stops before its next request: it can overrun by at most one response.

We rejected relying on OpenRouter's own key limit, because it ends requests with provider errors that Pi retries and that read as outages. A Pi Durable hook could not do this either: `beforeRequest` can only rewrite messages, and a throwing hook is skipped.

The default model is `deepseek/deepseek-v4.1-flash` on OpenRouter ($0.0342 per million input tokens, $0.1368 per million output tokens, and a 1M-token context, in pi-ai 1.4.0's catalog). It is among the cheapest capable models with tool calling and image input, so a household's daily use stays well under the default limit. `HAMKEY_MODEL` overrides it, and each Bot may name its own model.
