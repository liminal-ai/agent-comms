# Finding: an explicit reply and the collected turn text both become answers

**Decided:** option A, with one sentence of D in the delivery text (docs/09 item 4, 2026-10-03). Below is the finding as written before the decision.

Found in the V2 port's live checks (validation/v2), 2026-10-03. Not V2-specific: the Convex side is the same for T3 v0.0.44, V2 and Claude Code. No change is made in the port; this is a behaviour change for real agents, so it goes to Alder, Wrenn and Lee first.

## What happens today, step by step

1. A request is handed to the agent's turn. Its delivery is `delivered`, `collect: true`; the requester may be waiting in `comms send`.
2. During that turn the agent answers explicitly: `comms reply --as <me> <request-id> "text"`. Convex `reply` (convex/connector.ts) posts answer **A1** (`inReplyTo` the request, no `collectedFrom`) to the requester. It completes only an `ambiguous` or `uncertain` delivery of that request; a `delivered` one is left open, and the requester's wait isn't settled by A1. A1 reaches the requester as an ordinary message (inbox or thread).
3. The turn ends. The adapter reads the turn's final text and reports `replied`. Convex `collect` checks only for an earlier answer with `collectedFrom` = this delivery; there is none, so it posts answer **A2** (the final text, `collectedFrom` set), marks the delivery `replied` and settles the wait with A2.
4. The requester has two answers to one request. A2 is often not an answer at all but the agent describing what it did: in the run it was "Reply sent to @v2cat." (`raw/results.jsonl`, the void crash-window line and `connectorRestart`).

The `ambiguous` path already handles this the other way round: if the turn was ambiguous and the agent replied during it, the explicit reply completes the delivery (`ambiguous` in convex/connector.ts).

## Options

- **A. An explicit reply during the turn is the answer** (recommended). `reply` completes the open `delivered` delivery too: state `replied`, `answerMessageId` = A1, and the wait settles with A1 at once. When the turn ends, `collect` finds the delivery already answered and posts nothing (it returns the existing answer, as a repeat does today). The turn's final text stays in the agent's transcript.
  Cost: if an agent sends a partial reply ("working on it") and the real answer in its final text, the final text isn't delivered. To check before choosing: an outcome arriving after (`ambiguous`, `failed`) must not overwrite `replied`; the receipt proof for Claude Code waits (the answer-seen marker) must still apply to A1.
- **B. Keep both, mark A2 as a follow-up.** A2 is posted but not as an answer (not counted, not settling anything), so it shows as context. Still two messages for the requester.
- **C. Collect only when nothing was replied.** Same as A for the requester, but A1 doesn't settle the wait until the turn ends. Simpler, slower for the waiter.
- **D. In every case, say it in the delivery text**: "your final message is collected as your answer; use `comms reply` only for another message". Reduces the cases; doesn't remove them.

Recommendation: A with D. Either needs a failing test first, both harnesses (T3 and Claude Code), and a note in the agent docs.
