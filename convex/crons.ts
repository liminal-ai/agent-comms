import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// Send-and-wait: one fallback for unacknowledged answers, expiry, retention.
crons.interval("waits sweep", { minutes: 1 }, internal.waits.sweep, {});

// Reminders: expiries, then fires due this minute.
crons.interval("reminders", { minutes: 1 }, internal.reminders.tick, {});

export default crons;
