import type { Server } from "node:http";
export interface WebConfig {
  environment: string;
  convexUrl: string;
  /** Proxy mode: the token is read here at each call and never sent to the page. */
  adminTokenFile?: string;
}
/** Static page plus a token-free runtime-config.json. */
export function webServer(config: WebConfig, root: string): Server;
/** Proxy mode when `adminTokenFile` is set (the page calls /api/call and /api/watch here), static otherwise. */
export function webListener(config: WebConfig, root: string, log?: (line: string) => void): Server;
