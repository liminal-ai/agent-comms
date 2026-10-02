# Web view, capabilities fix pass (Hazel)

- Form fixes (1.4, 2): `tests-before.txt` (80f6b95, 4 of 4 failing) → `tests-after.txt` (9b9bf88).
- Inbox (2), on Cedar's scratch deployment (127.0.0.1:3212, never the live one), my dev server on
  3792 bound to it; `inbox-scratch.mjs` seeds 310 unread for @lee (the oldest 60 in a group, so
  all of them fall past the newest 200, the web's unread window), on top of Cedar's scale history:
  - `inbox-before/` (65090d6, unfixed web): the oldest unread unreachable; opening the group
    marked nothing (310 still unread); "Mark all read" left 150;
  - `inbox-after/` (fixed): the oldest reached through "Older" pages; opening the group marked its 60
    read (250 left); "Mark all read" left 0.
  Fix: the inbox pages with `before`/`nextBefore` and has an "Unread only" filter; "Mark all read"
  calls `markRead {all: true}`; opening any conversation marks its rows read, not only conversations
  among the loaded unread.
