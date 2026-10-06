import type { Server } from "node:http";
export function webServer(config: { environment: string; convexUrl: string; adminTokenFile?: string }, root: string): Server;
