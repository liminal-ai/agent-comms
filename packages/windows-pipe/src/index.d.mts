import type {Server} from 'node:http';
import type {Duplex} from 'node:stream';
export function windowsEndpoint(suffix?: string): string;
export function listenWindows(server: Server, endpoint: string): Promise<() => Promise<void>>;
export function connectWindows(endpoint: string, callback: (error: Error|null, stream?: Duplex) => void): void;
