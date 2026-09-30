// Vite's import.meta.glob, which convex-test uses to load the functions in tests.
interface ImportMeta {
  glob(pattern: string): Record<string, () => Promise<unknown>>;
}
