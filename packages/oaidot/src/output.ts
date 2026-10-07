import type { Writable } from "node:stream";

/** Await the actual write callback, rather than merely queuing bytes. */
export function writeOutput(stream: Writable, text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (stream.destroyed || !stream.writable) return reject(new Error("output is closed"));
    let finished = false;
    const cleanup = () => {
      stream.off("error", onError);
      stream.off("close", onClose);
    };
    const done = (error?: Error | null, fromEvent = false) => {
      if (finished) return;
      finished = true;
      // Writable may emit its error after invoking the failed write callback.
      // Keep the handler through that event so it cannot become unhandled.
      if (error && !fromEvent) setImmediate(cleanup); else cleanup();
      if (error) reject(error); else resolve();
    };
    const onError = (error: Error) => done(error, true);
    const onClose = () => done(new Error("output closed before write completed"), true);
    stream.once("error", onError);
    stream.once("close", onClose);
    try { stream.write(text, "utf8", (error) => done(error)); } catch (error) { done(error as Error); }
  });
}
