// Convex functions see deployment environment variables on process.env; nothing else of Node.
declare const process: { env: Record<string, string | undefined> };

// Vite's import.meta.glob, which convex-test uses to load the functions in tests.
interface ImportMeta {
  glob(pattern: string): Record<string, () => Promise<unknown>>;
}
