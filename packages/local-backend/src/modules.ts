// The repository's Convex functions, schema and crons, statically imported so
// a bundled local service carries them. test/modules.test.ts checks this list
// against the convex directory.

import * as alerts from "../../../convex/alerts.ts";
import * as connector from "../../../convex/connector.ts";
import * as conversations from "../../../convex/conversations.ts";
import crons from "../../../convex/crons.ts";
import * as directory from "../../../convex/directory.ts";
import * as inbox from "../../../convex/inbox.ts";
import * as registry from "../../../convex/registry.ts";
import * as reminders from "../../../convex/reminders.ts";
import schema from "../../../convex/schema.ts";
import * as waits from "../../../convex/waits.ts";
import type { ModuleMap } from "./runtime.ts";

export const modules: ModuleMap = { alerts, connector, conversations, directory, inbox, registry, reminders, waits };
export { crons, schema };
