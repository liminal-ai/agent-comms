# Follow-up 6: an open conversation past 100 messages marks new messages read (Hazel)

The open conversation re-marked itself read when the loaded message count changed; `conversations.view`
returns the latest 100, so past 100 messages the count never changed and new messages stayed unread.
Now the key is the latest message's id (`conversationReadKey`, `apps/web/src/lib/view.ts`).

- Unit: `tests-before.txt` (418ac3c, 1 of 2 failing: the key stayed 100) → `tests-after.txt` (31 pass).
- Live, on Hazel's own scratch deployment (an anonymous local Convex deployment in a detached
  worktree, own keys and state, 127.0.0.1:3216, a dummy admin token; never the live one;
  `scratch-convex.sh` is the wrapper, the admin key passed by env file only), seeded with a
  110-message @pat/@lee DM, the web view on 3792 bound to it, `open-past-100.mjs`:
  - `before/` (6c2fd8c, unfixed): 100 messages shown; both new messages stayed unread (1, then 2);
  - `after/` (fixed): both marked read at once (0 unread).
- The scratch deployment, its dev server and its worktree were removed afterwards.
