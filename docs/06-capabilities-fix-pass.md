# Capabilities fix pass

From the independent reviews of the capabilities pass (291e0fd..d464b91) by Alder, Wrenn and Reed, and the group's agreed fixes, 2026-10-02. Reviews: Reed `/srv/work/research/agent-comms-capabilities-review-20261002/REPORT.md`; Alder's and Wrenn's in the lhc-group thread. No redesign. No agent moves onto the plane until this pass is reviewed again in full by all three.

**Owners:** Cedar: Convex, the connector and the CLI. Hazel: the web view, the mod, rendering, and the acceptance evidence.

**Rules:**
- Each fix gets a failing test committed on its own before the fix. Use the reviewers' reproductions where they exist (scratch clones listed at the end).
- Every reproduced case stays in the permanent suite.
- Raw output for every live check is committed under `validation/capabilities-fix/`.
- Report to Reed by relay at each step: what landed, the commits, and anything you changed from this brief and why.

## 0. Contract first (Cedar writes, Hazel reviews, before any fix)

**0.1 Proof the agent saw an answer.** The fallback is suppressed only if the harness shows that the waiting command's own output, carrying the answer, reached the main model in the turn that ran it.
- **The wait records the waiter's turn id** when it's created: the mod knows its current turn; the T3 adapter reads the thread's active turn.
- **The CLI marks each answer it prints** with a begin line and an end line, both carrying the wait id and the answer's message id, around the answer text. No other command prints these markers (`comms status`, `read` and the rest show ids plainly), so a status listing or quoted text can't count as proof.
- **The CLI's `ack` is provisional.** It can't be proof, because the tool result only exists after the CLI exits. A result becomes `acknowledged` only when the harness confirms, within the fallback window (0.2), that a tool result in that turn contains both markers for that answer.
- **Main turn only.** A helper subagent's tool results never count, since they don't reach the main model (the same main-turn rule as fix pass 1).
- **Truncated output is no proof.** If the end marker is missing, the harness doesn't confirm.
- **Claude Code:** the mod checks the main turn's tool results and reports the confirmation.
- **T3:** the adapter does the same from the turn's tool output, if T3 exposes it to the adapter. Hazel checks this first, with evidence. If it doesn't, T3 falls back like Codex.
- **No proof, falls back:** a backgrounded CLI, Codex not reading its shell, a helper's call, truncated output, or any harness where the tool output can't be seen. The cost is an occasional duplicate, never a lost answer.
- **Tests:** a foreground answer confirmed; the id appearing only in `comms status` output or in quoted text (no confirmation); truncated output; a subagent's call; a backgrounded command.

**0.2 When the fallback timer starts.** The 2-minute window (`ACK_WINDOW_MS`) starts when the wait finishes, or when its client stops checking in (no `await` for `WAIT_HELD_MS`), whichever comes first. Not when the answer arrives. A crashed CLI can't postpone the fallback; a CLI still waiting on other answers doesn't cause early fallbacks. Once a fallback is due, a CLI reconnecting doesn't postpone it.
- **Tests:** an early group answer while another is still pending (no fallback while the CLI waits); a CLI that disappears mid-wait (the window starts once check-ins stop); a CLI reconnecting after the timeout (the due fallback still happens, once).

**0.3 `--json`.** Output stays one JSON object. Nothing is acknowledged before it's printed; 0.2 removes the early-fallback duplicate.

**0.4 Reminder detail access.** A reminder's detail (text, fires, answers) is readable only by its creator, its target, the target's owner and its report-to.

## 1. P1 fixes

1. **Acknowledgements per 0.1 and 0.2** (`convex/lib/waits.ts` `acknowledge`, sweep at `:196`; connector `refreshPresence`; the mod; the T3 adapter; CLI output). Tests: a T3 turn ending and another starting under a waiting command falls back; a Claude Code ack without the id in a tool result falls back; with it, it's acknowledged.
2. **Reminder detail access per 0.4** (`convex/connector.ts` `reminder` query, `:791`). Test: an agent on another machine is refused.
3. **No fixed-size reads over growing history.** Indexes over live states only, or pagination, for: the reminder expiry scan (`convex/lib/reminders.ts:274`); the alert scans for uncertain, claimed/delivered (reclaimed) and expired-reminder (`convex/lib/alerts.ts`); the resolve pass. The firing loop also checks `expiresAt` itself. Start with indexes; add a new delivery state only if the scale test (section 4) still fails. Tests: 500+ finished rows don't hide a new expiry, reclaim or uncertain delivery.
4. **One bad reminder can't stop the rest.** Cap reminder text at creation on every path (Convex create, web form, CLI) at `MAX_TEXT_CHARS`. A fire that still fails blocks only its own reminder, with the error as the reason, and the tick carries on.
   - **No partial writes.** A Convex mutation that catches an error keeps whatever it wrote before the throw. So validate and render everything before the first write; a caught failure must leave no stray message, delivery or fire row.
   - **Tests:** a 40,000-character reminder next to a normal one (the normal one fires); a failure injected after writing has begun (nothing left behind, the reminder blocked).
5. **Reports never block collecting the answer.** Clip the quoted answer so the report fits, pointing to the full answer in the conversation, and post it so its failure can't roll back the collect or a `comms reply`. Same rule: render and clip before writing.
   - A failed report must neither lose the collected answer nor post it twice when retried.
   - **Tests:** a 32,000-character answer to a `--report-to` reminder is collected and the report is posted clipped; a report failure injected after writing has begun (the answer kept once, no stray report); a retry after that failure (no duplicate).
6. **System participants are protected.** `setState`, `rebind` and `setProfile` refuse `kind === "system"`; `upgrade` sets an existing system participant back to `active`. Tests: retiring `@alerts` is refused; upgrade repairs one retired by a direct database edit.
7. **A dropped send keeps its key** (`packages/comms-cli/src/client.ts:59`, `cli.ts:160-187`). For keyed operations, a dropped connection retries with the same key, as for `unavailable`; if it gives up, it prints the `--key` line and exits 3 ("connector unreachable"), not 1, which means the connector refused. Test: a connector that drops after reading the send; the retry posts once.

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
- Two live checks on term-a: a foreground `comms send` confirmed through the tool-result proof (acknowledged, no fallback), and a backgrounded one that falls back once.

## 5. Not in this pass

Owner reassignment; file splitting (split only new additions); a new delivery state unless the scale test needs it. The minor findings (Reed's P3 list) are sorted by Cedar and Hazel into bugs, deliberate limits and preferences; they send Reed the sorted list, and only agreed bugs become work.

## Order

1. Section 0 (Cedar), Hazel's T3 tool-output check, and Hazel's review of 0.
2. Section 1, then 2 and 3, in parallel by owner.
3. Section 4.
4. Then Alder, Wrenn and Reed each review the whole result independently.

## Reproductions and reviews

- Reed's and Alder's reproductions are copied into `validation/capabilities-fix/repros/` (see its README: reference only, outside the suite; some of Reed's assert the buggy behaviour and must be inverted when ported).
- Originals: Reed `/tmp/review-waits-3191830`, `/tmp/review-rem-3192549`, `/tmp/review-reg-3193628`, `/tmp/review-x-cap`; Alder `/tmp/alder-cap-review`, `/tmp/alder-context-review.X11uKy`, `/tmp/alder-cap-breaking-review`.
- Wrenn: review `~/.local/state/lhc-campaigns/agent-comms-review-wrenn-20260930/capabilities/NOTES-wrenn.md`; live checks `/scratch/wrenn/cap-retest/`.
