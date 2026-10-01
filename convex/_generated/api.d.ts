/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as alerts from "../alerts.js";
import type * as connector from "../connector.js";
import type * as conversations from "../conversations.js";
import type * as crons from "../crons.js";
import type * as directory from "../directory.js";
import type * as inbox from "../inbox.js";
import type * as lib_core from "../lib/core.js";
import type * as lib_post from "../lib/post.js";
import type * as lib_registry from "../lib/registry.js";
import type * as lib_reminders from "../lib/reminders.js";
import type * as lib_waits from "../lib/waits.js";
import type * as registry from "../registry.js";
import type * as reminders from "../reminders.js";
import type * as validators from "../validators.js";
import type * as waits from "../waits.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  alerts: typeof alerts;
  connector: typeof connector;
  conversations: typeof conversations;
  crons: typeof crons;
  directory: typeof directory;
  inbox: typeof inbox;
  "lib/core": typeof lib_core;
  "lib/post": typeof lib_post;
  "lib/registry": typeof lib_registry;
  "lib/reminders": typeof lib_reminders;
  "lib/waits": typeof lib_waits;
  registry: typeof registry;
  reminders: typeof reminders;
  validators: typeof validators;
  waits: typeof waits;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
