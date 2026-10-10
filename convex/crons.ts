import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// Send-and-wait: one fallback for unacknowledged answers, expiry, retention.
crons.interval("waits sweep", { minutes: 1 }, internal.waits.sweep, {});

// Reminders: expiries, then fires due this minute.
crons.interval("reminders", { minutes: 1 }, internal.reminders.tick, {});

// Alerts: one per incident, to the affected agent's owner.
crons.interval("alerts", { minutes: 1 }, internal.alerts.scan, {});

// Deleted groups too large for one transaction: purged in bounded passes.
crons.interval("purge deleted groups", { minutes: 1 }, internal.conversations.purge, {});

export default crons;
