# Reviewer reproductions (capabilities review, 2026-10-02)

Copied from the reviewers' scratch clones in /tmp so a reboot doesn't lose them. They were written against d464b91 / 0ecf88e and are reference material, not part of the suite: the `.test.ts` names are kept for readability, but nothing here is picked up by `pnpm check` (this folder isn't in any vitest project).

- Some of Reed's tests pass by asserting the buggy behaviour (the send-and-wait ones, `waits.*` and `connlost.*`). Invert them when porting into the suite.
- Place each one where its original lived (convex/ or packages/connector/test/) when porting; imports are relative to that location.
- Wrenn's material: review `~/.local/state/lhc-campaigns/agent-comms-review-wrenn-20260930/capabilities/NOTES-wrenn.md`; live checks `/scratch/wrenn/cap-retest/`.
