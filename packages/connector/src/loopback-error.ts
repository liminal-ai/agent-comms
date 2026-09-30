import type { ErrorCode } from "@agent-comms/protocol";

/** A loopback protocol error: becomes `{ok: false, error: {code, message}}` with the matching HTTP status. */
export class LoopbackError extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}
