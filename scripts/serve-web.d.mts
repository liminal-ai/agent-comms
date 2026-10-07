import type { Server } from "node:http";
export interface WebConfig {
  environment: string;
  convexUrl: string;
  /** Proxy mode: the token is read here at each call and never sent to the page. */
  adminTokenFile?: string;
  /** Proxy mode: only these client addresses (as tailscale serve reports them in X-Forwarded-For) are served. */
  allowedClients?: string[];
  /** Development only: accept header-less loopback requests despite allowedClients. */
  devAllowLoopback?: boolean;
  /** Proxy mode: the Host values the page is published under; any other Host gets 403. */
  publicHosts?: string[];
  /** Listen on this unix socket (mode 600) instead of 127.0.0.1:port, so only this user and root can reach the proxy hop. */
  socket?: string;
}
/** Static page plus a token-free runtime-config.json. */
export function webServer(config: WebConfig, root: string): Server;
/** Proxy mode when `adminTokenFile` is set (the page calls /api/call and /api/watch here); it refuses to start without `allowedClients` and `publicHosts`. Static otherwise. */
export function webListener(config: WebConfig, root: string, log?: (line: string) => void): Server;
