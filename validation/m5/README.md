# M5: first milestone (local), 2026-09-30

lim-builder; local Convex (3240); the connector with the T3 adapter on the machine's default socket (`/run/user/1000/agent-comms/connector.sock`); `comms` on the agents' PATH (`~/.local/bin/comms` → `/srv/work/agent-comms`, main); Hazel's fresh T3 on 3780 with a native Claude, a Claude-LHC and a Codex thread promoted as `t3-native`, `t3-lhc`, `t3-codex`. "Lee typing" is a `thread.turn.start` with a foreign message id, as the web UI sends it.

| M5 check | Result |
|---|---|
| One agent sends another a request with `comms send`, and gets the matched answer back in its own thread | Codex, asked in its thread, ran `comms send --as t3-codex @t3-native "…17 times 23…"` from its shell; native Claude answered `391`, collected and linked; the answer was delivered into Codex's thread (`delivered`). |
| An answer wakes the requester and nothing it does next is collected (no loop) | 90 s after the answer was delivered: 2 messages in the conversation, nothing collected from the answer's turn. |
| Nothing typed directly into a thread reaches Convex | A private marker in Lee's message to Codex: not in any Convex message. |
| Lee posts in a group addressing two agents; both replies land linked | Group of Lee, native, LHC, Codex; Lee addressed native and LHC: both `replied`, answers linked to his message; Codex (not addressed) not woken. |
| A busy-thread delivery waits, then runs as its own turn | `validation/m3` (busy scenario): `replied`, own turn. |
| A message typed into the same turn makes it ambiguous, and `comms reply` completes it | LHC: `ambiguous`, the unmatched notice went into the thread, the agent ran `comms reply` itself: `replied` ("completed by comms reply …"), answer `TYPED-M5`. |
| The connector is killed mid-delivery and restarted, with no double run | `validation/m3` (kill scenario): SIGKILL after `delivered`, replay from the cursor, one run, one answer. |

The plan names a native Claude and a Codex thread; all three providers took part.
