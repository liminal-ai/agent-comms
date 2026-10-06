export function readPrivateWindowsSecret(path: string): string;

export function readCredential(path: string): string;
export function protectPrivateWindowsFile(path: string): void;
export function privateWindowsDirectory(path: string, mode: 'check' | 'protect'): boolean;
