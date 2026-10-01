# Capabilities acceptance: Hazel's items (2, 6, 9; web side of 11)

All on the installed services: the connector service, local Convex, T3 on 3780, term-a, and the installed web view on 3790.

- **2, term-a → t3-native** (`item2-term-a-to-t3/`): `comms send --as term-a @t3-native` printed the
  answer `42` in the call, exit 0. `status.json`: result `acknowledged`, wait inactive, no follow-ups.
  term-a's mod log was empty for the 2 min 40 s after: no extra turn, no fallback.
- **2, T3 → term-a** (`item2-t3-to-term-a/`, sent by Cedar's t3-codex): one delivery, one turn on
  term-a (delivered 20:01:59, replied "term-a pong" 20:02:01), nothing after. Cedar's side: the call
  returned the answer, result `acknowledged`.
- **6** (`item6-send-owner/`): term-a's `comms send @owner` returned at once ("→ @lee: in their
  inbox"). `item6-web.mjs` on 3790: unread in Lee's inbox, still unread after a reload, read once the
  conversation was opened.
- **9, term-a** (`../mod-0.1.3/`): a reminder fire rendered as a reminder from @reminders with its
  creator, answered and recorded; the report to term-a arrived as a notice and wasn't collected; the
  reminder ended `done` and Lee got the ending notice.
- **11, web side** (`item11-web/`, read-only): the Alerts tab lists the 11a uncertain alert
  (resolved), the two connector-silent incidents (stop, start, stop) and the acc10exp expiry. All are
  unread "Alert" notices from @alerts in Lee's inbox. One alert was still open for a real uncertain
  delivery (j97bgecyd…, 18:44Z); I've asked Cedar about it.
