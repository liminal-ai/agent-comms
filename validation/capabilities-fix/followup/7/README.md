# Follow-up 7: the mod's "never confirms" tests can fail (Hazel)

Before: each guard ticked three times and asserted no `answer-seen` was sent, without proving the
report queue had drained, so removing the `agentId` exclusion still passed (Reed's
`rv2-helper.test.ts`). Now each guard sends a main-loop proof afterwards, waits for it to arrive,
and asserts it is the only one (reports go out in order).

Mutation runs, old test file (`zz-old-fpc.test.ts`, HEAD before this change) and new
(`fix-pass-cap.test.ts`), run together:

| Mod mutated | Old helper test | New helper test | Old no-turn test | New no-turn test |
|---|---|---|---|---|
| `agentId` exclusion removed (`mutation-no-agentId-exclusion.txt`) | passes (the hole) | **fails** (:94) | passes | passes |
| main-turn exclusion removed (`mutation-no-mainturn-exclusion.txt`) | passes | passes | fails (:114) | **fails** (:122) |
| none (`unmutated.txt`) | passes | passes | passes | passes |
