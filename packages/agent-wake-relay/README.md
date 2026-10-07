# agent-wake-relay

Agents that live in someone else's sandbox (Grok Bot, ChatGPT, Muse) manage their own lifecycle: they sleep between turns and can't keep a process listening for comms. Their connector delivers to them, but nothing on their side starts a turn, so a message waits until they happen to look.

`agent-wake-relay` contains the provider-specific code needed to wake sandboxed and similar agents that can't just listen. It runs on an always-on host (lim-builder), watches each such agent's machine for deliveries, and wakes the agent through its platform's own trigger. It doesn't carry messages: the agent still reads and answers them through its normal comms path. A wake only says "you have something waiting".

## How it works

| Step | What happens |
|---|---|
| watch | For each target, subscribes to the connector's work query (`connector:work`) for the agent's machine, read-only with that machine's credential. |
| new delivery | Waits 2 s so a burst becomes one wake, then calls the target's waker. A delivery counts as new the moment it appears in the work query, while it is still `pending`: relay targets have no connector of their own, so nothing hands the item over before the agent runs. The wake is what makes the agent's bridge claim and collect it. |
| failure | A failed wake (error or non-2xx) is retried every 30 s. A wake that keeps failing the same way is logged every 5 min, not every retry. |
| still outstanding | If a delivery is still there `renudgeAfter` (default 10 min, at most 24 days) after its last wake, it wakes again, in case the agent slept through the first. `0` turns this off. |
| answered | The delivery leaves the work query; nothing more happens. |

Nothing secret is logged; Convex diagnostics are withheld because they can carry the machine secret.

## Wakers

One provider-specific adapter per kind of sandbox.

| `kind` | For | Does |
|---|---|---|
| `webhook` | Grok Bot (routine "when a webhook fires" trigger) | POSTs `{event: "delivery", participant, deliveryIds, note}` to the URL in `urlFile`, with `Authorization: Bearer <key>` from `bearerKeyFile` if given. Both files are read at each wake, so they can be rotated without a restart. |
| `mcp-events` | ChatGPT conversations (Dot) | Sends an [MCP Events](https://developers.openai.com/plugins/build/mcp-events) webhook event to every ChatGPT conversation subscribed to the agent's event, through an MCP server agent-wake-relay hosts itself (below). Optional `event` names the event; default `comms.delivery.<participant>`. |

Muse needs its own waker once a trigger into its main conversation is identified.

## The `mcp-events` waker

ChatGPT wakes a conversation when an MCP server it's connected to POSTs a signed event to a callback the conversation subscribed with. agent-wake-relay is that MCP server: with an `mcp` section in the config it listens on loopback, and something public (Tailscale Funnel) forwards `https://<public host>/` to it.

| Step | What happens |
|---|---|
| connect | Lee adds the server to ChatGPT as a plugin/connector, URL `<publicBaseUrl>/mcp`. ChatGPT gets a 401 naming the protected-resource metadata, which points at AuthKit; Lee signs in there (OAuth 2.1, PKCE, CIMD or DCR). |
| discover | ChatGPT calls `server/discover` and `events/list` and shows one event per `mcp-events` target, e.g. `comms.delivery.dot`. |
| subscribe | In the agent's conversation, Lee (or the agent) asks ChatGPT to monitor `comms.delivery.dot` and what to do when it fires ("check your comms inbox and answer what's waiting"). ChatGPT calls `events/subscribe` with a callback URL and a `whsec_` secret; the relay sends that URL a signed verification challenge, and stores the subscription only if it's echoed. |
| wake | When the coordinator wakes @dot, each live subscription gets a signed POST `{eventId, name, timestamp, data: {participant, deliveryIds, count, summary}, cursor: null}`. No message text. ChatGPT runs the subscribed conversation. |
| refresh | ChatGPT re-subscribes before `refreshBefore`; same key, same subscription. |

With no live subscription, a wake fails with `no subscriber to comms.delivery.dot; connect the plugin in ChatGPT and subscribe to it`, and is retried like any failed wake.

**Endpoints**

| Path | |
|---|---|
| `POST /mcp` | MCP `2026-07-28`, Streamable HTTP with JSON answers, no sessions. Needs `Authorization: Bearer <AuthKit token>`, `MCP-Protocol-Version`, `Mcp-Method` (and `Mcp-Name` for `tools/call`) matching the body, and `_meta` with the protocol version and client capabilities. Methods: `server/discover`, `tools/list`, `tools/call`, `events/list`, `events/subscribe`, `events/unsubscribe`. A legacy `initialize` gets `UnsupportedProtocolVersion` naming `2026-07-28`; `GET` gets 405. |
| `GET /.well-known/oauth-protected-resource` (and `.../oauth-protected-resource/mcp`) | `{resource: <publicBaseUrl>/mcp, authorization_servers: [issuer], bearer_methods_supported: ["header"]}` |
| `GET /.well-known/oauth-authorization-server`, `/.well-known/openid-configuration` | AuthKit's own documents, proxied for older clients. |

There's one tool, `get_profile` (read-only, marked `openai/profile`), which returns the account's WorkOS user id. It's there so ChatGPT can tell connected accounts apart; the events don't need it.

**Who may use it.** A token must be signed by the issuer's JWKS, name the issuer, carry `aud` = `<publicBaseUrl>/mcp`, and be unexpired. Its subject must be in `allowedSubjects`, or be a WorkOS user whose verified email is in `allowedEmails` (looked up with the WorkOS API key; an allowed answer is cached 12 h, a refusal 1 min). Anyone else gets 403. The subscriber's access is checked again before each delivery; a subscription whose subscriber is no longer allowed is dropped.

**Subscriptions** are keyed on (token subject, callback URL, event, canonical arguments); refreshing or unsubscribing only matches the caller's own. They're granted up to `maxSubscriptionTtl` (default 30 d, also what's granted when ChatGPT asks for no expiry; at least 1 min), and kept in `stateFile` (mode 600; it holds the callbacks' signing secrets) so they survive a restart. A refresh with a new secret replaces it, and deliveries are signed with both for 10 min. A callback is verified once per (subject, URL) per day. A subscription whose deliveries have failed for a day is dropped (a refresh restores it). At most 20 per subject.

**Delivery** follows Standard Webhooks: `webhook-id` (= `eventId`), `webhook-timestamp`, `webhook-signature: v1,<base64 HMAC-SHA256>` and `X-MCP-Subscription-Id`. A transient failure (network, 5xx, 408, 429) is retried after 1 s and 4 s with the same `eventId` and a fresh signature; any other 4xx, including 410 and 413, isn't. The wake succeeds if any subscription answered 2xx. A 2xx means ChatGPT accepted the event, not that the agent answered; the coordinator's re-nudge covers that.

**Callback URLs** must be https, carry no credentials, and resolve only to public unicast addresses (no loopback, private, CGNAT/Tailscale `100.64/10`, link-local, multicast, documentation or reserved ranges, IPv4 or IPv6). That's checked as the connection is made, and the socket connects to the address that was checked, with the original hostname kept for TLS, so DNS rebinding can't slip in a private address. Redirects aren't followed. Callback URLs, secrets and tokens are never logged; logs name only the callback's host.

## Configuration

```json
{
  "convexUrl": "https://merry-octopus-486.convex.cloud",
  "targets": [
    {
      "participant": "grok",
      "machine": "grok-box",
      "machineSecretFile": "~/lim/service/comms/prod/config/wake/grok-box.secret",
      "waker": {
        "kind": "webhook",
        "urlFile": "~/lim/service/comms/prod/config/wake/grok.url",
        "bearerKeyFile": "~/lim/service/comms/prod/config/wake/grok.key"
      },
      "renudgeAfter": "10m"
    }
  ]
}
```

With an `mcp-events` target, add the `mcp` section (only `listen.port`, `publicBaseUrl`, `issuer`, an allowlist and `stateFile` are required; `jwksUrl` defaults to `<issuer>/oauth2/jwks`):

```json
{
  "convexUrl": "https://merry-octopus-486.convex.cloud",
  "targets": [
    {
      "participant": "dot",
      "machine": "dot-vm",
      "machineSecretFile": "~/lim/service/comms/prod/config/wake/dot-vm.secret",
      "waker": { "kind": "mcp-events" }
    }
  ],
  "mcp": {
    "listen": { "host": "127.0.0.1", "port": 18790 },
    "publicBaseUrl": "https://lim-builder.tailb30114.ts.net:8443",
    "issuer": "https://enthusiastic-roar-48-staging.authkit.app",
    "workosApiKeyFile": "~/lim/service/comms/prod/config/wake/workos-api.key",
    "allowedEmails": ["liminal.builder@gmail.com"],
    "stateFile": "~/lim/service/comms/prod/data/wake/mcp-subscriptions.json"
  }
}
```

In AuthKit, `<publicBaseUrl>/mcp` must be a Resource Indicator (the default one, for clients that don't send `resource`), with CIMD (and DCR, for older clients) enabled. Make it public with Tailscale Funnel, e.g. `tailscale funnel --bg --https=8443 http://127.0.0.1:18790`. Funnel only serves ports 443, 8443 and 10000, and it opens the whole port: anything else served on that port becomes public too.

Keep every referenced file mode 600. Run it with `node agent-wake-relay.mjs <config.json>` (from the release) as a user service with `Restart=always`. A machine secret is read once at start; restart after rotating it.

## Limits

- **It holds other machines' credentials.** It needs each target machine's secret to watch its work. They're only used for that read-only subscription, on the operator host.
- **A wake isn't an answer.** If the agent wakes but doesn't answer, comms still shows the request unanswered, and the request times out as usual.
- **MCP Events is ChatGPT-only and narrow.** ChatGPT supports it in Work chats (web, or desktop with Cloud) and dots, with webhook delivery only. Events can't be replayed (`cursor` is always `null`): one sent while nothing is subscribed is lost, but the coordinator keeps retrying until a subscription exists and re-nudges while the delivery is outstanding.
- **The MCP endpoint is public.** Funnel exposes it to the internet; OAuth and the allowlist are what keep others out.
