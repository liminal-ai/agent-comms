# web

Lee's view onto the comms server. A side pane with four tabs:

- **Agents**, the agent registry: every participant with presence, owner, description and duties (Edit sets them through `registry.setProfile`), pause, resume, retire, and promotion. People, system participants and retired agents are grouped below.
- **Inbox**: messages addressed to the person you're posting as, newest first, with the unread count on the tab, in the header and in the page title. Opening a conversation marks what's in it read; so does clicking an item.
- **Reminders**: live reminders with their schedule, state, fires and next fire; pause, resume, blocked (with a reason), done, cancel; each one's history of fires and skips; a form to set one as the person you're posting as.
- **Alerts**: open incidents first, then resolved ones, and the alert thresholds.

Then conversations and groups (create, add and remove members), each conversation with the delivery state of every addressed agent (`uncertain` in solid red, `ambiguous` and `failed` outlined), and posting as a person with @mentions (only @named members are woken).

The logic (presence, profile and reminder forms, labels) is in `src/lib/view.ts`, tested with `pnpm test` (`test/view.test.ts`); the Convex functions it calls are listed in `packages/protocol/README.md`.

Live subscriptions throughout. Three ways the page reaches the data, picked once at startup from `runtime-config.json`:

- **proxy** (the released `serve-web.mjs` with `adminTokenFile` in its web config; this is how lim-builder serves prod and staging): the page sends no token. It calls `POST /api/call` and one streaming `POST /api/watch` on its own origin, and the web service adds the admin token, read from the file at each call, before forwarding to Convex. The admin token never reaches a browser. Who may load the page is decided by `allowedClients` in the web config: the tailnet addresses `tailscale serve` reports in the single `X-Forwarded-For` value it sets (it overwrites the header with the real peer). Any other client, and any request with a missing, multi-valued or unparsable header, gets 403. `devAllowLoopback: true` lets header-less loopback requests through in development; it is off in prod. `publicHosts` lists the names the page is published under; any other Host gets 403, so a DNS-rebinding page can't reach the API. Proxy mode refuses to start without `allowedClients` and `publicHosts` unless `devAllowLoopback` is set. Errors from the server reach the page as our own `{code, message}` or a bare kind ("the server refused the call's arguments"), never the call's arguments.
- **local** (the local comms service): the same API, with a per-session token from a `#token=` link.
- **convex** (dev and the plain static build): the page talks to Convex directly with the development admin token (`COMMS_ADMIN_TOKEN` on the deployment), entered once and kept in localStorage. Presence: green idle (with how long), amber busy, hollow offline, dotted red when the agent's machine hasn't been heard from in 90 s (never shown as idle).

```sh
# dev, on lim-builder (127.0.0.1:3790), token pre-filled from a file so it's never typed:
AGENT_COMMS_ADMIN_TOKEN_FILE=<file holding the admin token> VITE_CONVEX_URL=http://127.0.0.1:3240 npx vite
# static build:
VITE_CONVEX_URL=<deployment url> npx vite build   # → dist/
```

Phones get one pane at a time, picked in the header. Reaching it from Lee's phone needs a deployment the phone can reach: that's the cloud checkpoint (M6).
