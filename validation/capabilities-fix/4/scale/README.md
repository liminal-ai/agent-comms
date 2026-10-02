# Fix pass section 4: the scale run (scratch deployment, never the live one)

A fresh anonymous local Convex deployment (`anonymous-agent`, 127.0.0.1:3212, its own generated keys, its own state in a detached scratch worktree), running main's functions (4cabf7f) plus the scratch-only `scaleSeed.ts` (this folder; never deployed to the live backend). Driven by `run.sh`; output in `run.journal.txt`.

- **History seeded:** 5,000 finished answer deliveries, 2,000 replied deliveries with high claim counts, 1,500 uncertain deliveries from two days ago, 3,000 finished reminders (expired, done, cancelled), 2,000 resolved alerts, and 2,000 ended waits with their results. In all: 10,500 deliveries, 3,000 reminders, 2,000 alerts, 2,000 waits.
- **New items among it:** a reminder expiring after 1 minute, a reminder due after 1 minute, a new uncertain delivery, and an in-flight delivery claimed 9 times.
- **Result:** the deployment's own minute crons, and then a manual run of each, found every new item. The expiring reminder ended `expired` with 0 fires; the due one fired; the uncertain and reclaimed deliveries each opened one alert. None of the 1,500 old uncertain deliveries, the replied deliveries with high claim counts, or the resolved alerts opened or re-opened anything. Each cron function took about 0.55 s end to end, including the CLI's own start-up. There were no errors or read-limit failures.
- The manual `reminders:tick` reports 0 because the minute cron had already handled both reminders during the 75-second wait; `stateOf` shows the outcome.
