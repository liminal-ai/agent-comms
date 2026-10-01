# DeliveryCheck.createdAt (for Hazel's 1.8 tightening)

Added in 7ab031e. The test changes went in the same commit as the change, not committed failing first. To show they test it, the new `packages/connector-stub/test/stub.test.ts` was run against the code before the change (b5b76f6) on 2026-10-01: 19 pass, 1 fails ("asks the session about unfinished deliveries instead of re-running them": the check items lack `createdAt`). Against 7ab031e all 20 pass; the connector test asserts `createdAt` on the real connector's check items too.
