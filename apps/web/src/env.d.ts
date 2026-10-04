declare const __DEV_ADMIN_TOKEN__: string;
interface Window {
  commsConfig?: { environment: string; convexUrl: string; adminToken?: string };
}
