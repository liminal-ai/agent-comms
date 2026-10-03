# Web view, capabilities fix pass (Hazel)

- Form fixes (1.4, 2): `tests-before.txt` (80f6b95, 4 of 4 failing) → `tests-after.txt` (9b9bf88).
- Inbox (2), on Cedar's scratch deployment (127.0.0.1:3212, never the live one), my dev server on
  3792 bound to it; `inbox-scratch.mjs` seeds 310 unread for @lee (the oldest 60 in a group, so
  all of them fall past the newest 200, the web's unread window), on top of Cedar's scale history:
  - `inbox-before/` (65090d6, unfixed web): the oldest unread unreachable; opening the group
    marked nothing (310 still unread); "Mark all read" left 150;
  - `inbox-after/` (fixed): the oldest reached through "Older" pages; opening the group marked its 60
    read (250 left); "Mark all read" left 0.
  Fix: the inbox pages (`before`/`nextBefore`, since follow-up 5 Convex's cursor `cursor`/`nextCursor`) and has an "Unread only" filter; "Mark all read"
  calls `markRead {all: true}`; opening any conversation marks its rows read, not only conversations
  among the loaded unread.
- P3 bugs 7 and 8: `p3-tests-before.txt` (8e31b9d, 3 of 6 failing, 3 guards) → `p3-tests-after.txt`
  (29 pass). 7: the Alerts badge and open list come from `alerts.list {openOnly: true}`, the
  resolved list from the recent 100 (no history paging, per Reed). 8: posting as defaults to the
  saved choice if it's an active person, else @lee if it exists, else the first active person; the
  list offers active people only. `p3-live/`: read-only check on 3791 (live deployment).
