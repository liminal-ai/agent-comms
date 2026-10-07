# agent-wake-relay

Agents that live in someone else's sandbox (Grok Bot, ChatGPT, Muse) manage their own lifecycle: they sleep between turns and can't keep a process listening for comms. Their connector delivers to them, but nothing on their side starts a turn, so a message waits until they happen to look.

`agent-wake-relay` contains the provider-specific code needed to wake sandboxed and similar agents that can't just listen. It runs on an always-on host (lim-builder), watches each such agent's machine for deliveries, and wakes the agent through its platform's own trigger. It doesn't carry messages: the agent still reads and answers them through its normal comms path. A wake only says "you have something waiting".

## How it works

| Step | What happens |
|---|---|
| watch | For each target, subscribes to the connector's work query (`connector:work`) for the agent's machine, read-only with that machine's credential. |
| new delivery | Waits 2 s so a burst becomes one wake, then calls the target's waker. |
| failure | A failed wake (error or non-2xx) is retried every 30 s. |
| still outstanding | If a delivery is still there `renudgeAfter` (default 10 min) after its last wake, it wakes again, in case the agent slept through the first. `0` turns this off. |
| answered | The delivery leaves the work query; nothing more happens. |

Nothing secret is logged; Convex diagnostics are withheld because they can carry the machine secret.

## Wakers

One provider-specific adapter per kind of sandbox.

| `kind` | For | Does |
|---|---|---|
| `webhook` | Grok Bot (routine "when a webhook fires" trigger) | POSTs `{event: "delivery", participant, deliveryIds, note}` to the URL in `urlFile`, with `Authorization: Bearer <key>` from `bearerKeyFile` if given. Both files are read at each wake, so they can be rotated without a restart. |

Muse and ChatGPT (Dot) need their own wakers once a trigger into their main conversation is identified.

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

Keep every referenced file mode 600. Run it with `node agent-wake-relay.mjs <config.json>` (from the release) as a user service with `Restart=always`. A machine secret is read once at start; restart after rotating it.

## Limits

- **It holds other machines' credentials.** It needs each target machine's secret to watch its work. They're only used for that read-only subscription, on the operator host.
- **A wake isn't an answer.** If the agent wakes but doesn't answer, comms still shows the request unanswered, and the request times out as usual.
