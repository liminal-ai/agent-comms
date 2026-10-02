# Capabilities fix pass

From the independent reviews of the capabilities pass (291e0fd..d464b91) by Alder, Wrenn and Reed, and the group's agreed fixes, 2026-10-02. Reviews: Reed `/srv/work/research/agent-comms-capabilities-review-20261002/REPORT.md`; Alder's and Wrenn's in the lhc-group thread. No redesign. No agent moves onto the plane until this pass is reviewed again in full by all three.

**Owners:** Cedar: Convex, the connector and the CLI. Hazel: the web view, the mod, rendering, and the acceptance evidence.

**Rules:**
- Each fix gets a failing test committed on its own before the fix. Use the reviewers' reproductions where they exist (scratch clones listed at the end).
- Every reproduced case stays in the permanent suite.
- Raw output for every live check is committed under `validation/capabilities-fix/`.
- Report to Reed by relay at each step: what landed, the commits, and anything you changed from this brief and why.

## 0. Contract first (Cedar writes, Hazel reviews, before any fix)

**0.1 Proof the agent saw an answer.** An acknowledgement suppresses the fallback only if the harness shows the answer reached the model in the same turn that ran the waiting command.
- The wait records the waiter's turn id when it's created: the mod knows its current turn; the T3 adapter reads the thread's active turn.
- The CLI prints each answer's message id next to its text, so it can be found in the turn's tool output.
- **Claude Code:** the mod reports that the message id appeared in a tool result of that turn. Only then does the ack count.
- **T3:** the adapter does the same from the turn's tool output, if T3 exposes it to the adapter. Hazel checks this first, with evidence. If it doesn't, T3 falls back like Codex.
- **No proof, falls back:** a backgrounded CLI, Codex not reading its shell, or any harness where the tool output can't be seen. The cost is an occasional duplicate, never a lost answer.

**0.2 When the fallback timer starts.** The 2-minute window (`ACK_WINDOW_MS`) starts when the wait finishes, or when its client stops checking in (no `await` for `WAIT_HELD_MS`), whichever comes first. Not when the answer arrives. A crashed CLI can't postpone the fallback; a CLI still waiting on other answers doesn't cause early fallbacks.

**0.3 `--json`.** Output stays one JSON object. Nothing is acknowledged before it's printed; 0.2 removes the early-fallback duplicate.

**0.4 Reminder detail access.** A reminder's detail (text, fires, answers) is readable only by its creator, its target, the target's owner and its report-to.

## 1. P1 fixes

1. **Acknowledgements per 0.1 and 0.2** (`convex/lib/waits.ts` `acknowledge`, sweep at `:196`; connector `refreshPresence`; the mod; the T3 adapter; CLI output). Tests: a T3 turn ending and another starting under a waiting command falls back; a Claude Code ack without the id in a tool result falls back; with it, it's acknowledged.
2. **Reminder detail access per 0.4** (`convex/connector.ts` `reminder` query, `:791`). Test: an agent on another machine is refused.
3. **No fixed-size reads over growing history.** Indexes over live states only, or pagination, for: the reminder expiry scan (`convex/lib/reminders.ts:274`); the alert scans for uncertain, claimed/delivered (reclaimed) and expired-reminder (`convex/lib/alerts.ts`); the resolve pass. The firing loop also checks `expiresAt` itself. Start with indexes; add a new delivery state only if the scale test (section 4) still fails. Tests: 500+ finished rows don't hide a new expiry, reclaim or uncertain delivery.
4. **One bad reminder can't stop the rest.** Cap reminder text at creation on every path (Convex create, web form, CLI) at `MAX_TEXT_CHARS`. A fire that still fails blocks only its own reminder, with the error as the reason, and the tick carries on. Test: a 40,000-character reminder next to a normal one; the normal one fires.
5. **Reports never block collecting the answer.** Clip the quoted answer so the report fits, pointing to the full answer in the conversation, and post it so its failure can't roll back the collect or a `comms reply`. Test: a 32,000-character answer to a `--report-to` reminder is collected and the report is posted clipped.
6. **System participants are protected.** `setState`, `rebind` and `setProfile` refuse `kind === "system"`; `upgrade` sets an existing system participant back to `active`. Tests: retiring `@alerts` is refused; upgrade repairs one retired by a direct database edit.
7. **A dropped send keeps its key** (`packages/comms-cli/src/client.ts:59`, `cli.ts:160-187`). For keyed operations, a dropped connection retries with the same key, as for `unavailable`; if it gives up, it prints the `--key` line and exits 1. Test: a connector that drops after reading the send; the retry posts once.

## 2. P2 fixes

- **Reminder names:** one line only (refuse newlines and control characters at creation); escaped when rendered (`render.ts:126`). Test: a name carrying a forged header line is refused.
- **Report-to disclosed:** a fire with `--report-to` says "your answer is reported to @x", in the text and the metadata.
- **`comms await`:** honours `--wait`, and works after exit 4 for results that can still be answered; otherwise remove both from the usage text and README. Cedar picks; the docs match.
- **Retired participants:** refuse a retired person as owner (Convex and the web picker); refuse a retired watched agent at creation, and cancel a reminder (telling its creator) when its watched agent retires. Owner reassignment is not in this pass.
- **Thresholds:** `Number.isFinite` and integer checks before the range check.
- **Inbox:** older unread messages reachable (pagination or an unread filter); "mark all read" marks all, not only those shown; opening any conversation marks its rows read.

## 3. Docs

- The Codex case: an agent that doesn't keep reading its shell may never see an answer; it falls back.
- The 60-second hold: an answer arriving while the CLI hasn't checked in for 60 s goes to the thread.
- `docs/00-overview.md`: the notice kind. `packages/protocol/README.md`: remove "until each is built … unsupported", add `key` to `send`, and match `await` to what's built.
- A recovery and deployment checklist covering upgrades from older deployments (the owner migration stages). Not a code change.

## 4. Rerun (Hazel leads, Cedar joins)

- The affected acceptance items, on the installed services.
- **7c with a real CLI kill** after printing and before acknowledging.
- Restart tests confirm the connector process actually died.
- A live T3 turn changing under a waiting command.
- A scale run with thousands of finished rows (deliveries, reminders, alerts) on a scratch deployment, never the live one.
- Wrenn's live T3 send-and-wait, kept as a regression check.

## 5. Not in this pass

Owner reassignment; file splitting (split only new additions); a new delivery state unless the scale test needs it. The minor findings (Reed's P3 list) are sorted by Cedar and Hazel into bugs, deliberate limits and preferences; they send Reed the sorted list, and only agreed bugs become work.

## Order

1. Section 0 (Cedar), Hazel's T3 tool-output check, and Hazel's review of 0.
2. Section 1, then 2 and 3, in parallel by owner.
3. Section 4.
4. Then Alder, Wrenn and Reed each review the whole result independently.

Reproductions: `/tmp/review-waits-3191830`, `/tmp/review-rem-3192549`, `/tmp/review-reg-3193628`, `/tmp/review-x-cap`; Alder's probes and Wrenn's live checks (ask them for paths).
