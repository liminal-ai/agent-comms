declare const __DEV_ADMIN_TOKEN__: string;
interface Window {
  commsConfig?: { environment: string; mode?: "convex" | "local"; convexUrl?: string; adminToken?: string };
}
