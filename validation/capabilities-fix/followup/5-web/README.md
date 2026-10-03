# Follow-up 5, the web side (Hazel): the inbox with Convex's opaque cursor

Cedar's 1088b49 renamed the web inbox's paging from `before`/`nextBefore` to `cursor`/`nextCursor`
(Convex's own pagination cursor, exact when items share a timestamp). Checked against the Inbox code
(the Newer/Older stack works the same with string cursors), then both live web checks rerun on a fresh
scratch deployment of Hazel's own (`hazel-scratch`, 127.0.0.1:3216, own keys, a dummy token; never the
live one; removed afterwards):
- `inbox/`: 310 unread, the oldest 60 past the newest 200: the oldest reached through Older pages,
  opening the group cleared its 60, "Mark all read" left 0. ALL PASS.
- `open-past-100/`: a 250-message conversation open as @lee; both new messages marked read. ALL PASS.
The identical-timestamp case itself is Cedar's Convex test (100 notices in one tick, pages of 50).
