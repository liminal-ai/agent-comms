import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// Send-and-wait: one fallback for unacknowledged answers, expiry, retention.
crons.interval("waits sweep", { minutes: 1 }, internal.waits.sweep, {});

export default crons;
