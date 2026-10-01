// The send-and-wait sweep, run every minute (crons.ts): fallbacks, expiry, retention.

import { internalMutation } from "./_generated/server";
import { sweep as sweepWaits } from "./lib/waits";

export const sweep = internalMutation({
  args: {},
  handler: async (ctx) => sweepWaits(ctx, Date.now()),
});
