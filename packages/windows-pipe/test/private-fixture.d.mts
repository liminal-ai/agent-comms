export function privateFixture(content: string): Promise<{path: string; cleanup(): Promise<void>}>;
