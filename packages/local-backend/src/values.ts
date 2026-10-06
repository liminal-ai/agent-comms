// Values as this repository's Convex functions use them: validation against
// Convex validator JSON, Convex's ordering, and an order-preserving byte key
// for index entries. Only what the schema and function args need; anything
// else fails closed with Unsupported.

export class Unsupported extends Error {
  override name = "Unsupported";
  constructor(what: string) {
    super(`local mode doesn't support ${what}`);
  }
}

export type Value = undefined | null | number | boolean | string | Value[] | { [k: string]: Value };

/** Convex validator JSON (convex 1.46 `Validator.json`). */
export type ValidatorJson =
  | { type: "any" | "null" | "number" | "boolean" | "string" }
  | { type: "bigint" | "bytes" }
  | { type: "id"; tableName: string }
  | { type: "literal"; value: string | number | boolean }
  | { type: "array"; value: ValidatorJson }
  | { type: "object"; value: Record<string, { fieldType: ValidatorJson; optional: boolean }> }
  | { type: "record"; keys: ValidatorJson; values: { fieldType: ValidatorJson; optional: boolean } }
  | { type: "union"; value: ValidatorJson[] };

/** Rejects validator kinds local storage can't hold (it stores JSON). Run once per schema/function. */
export function checkSupported(json: ValidatorJson, at = "value"): void {
  switch (json.type) {
    case "any": case "null": case "number": case "boolean": case "string": case "id": return;
    case "literal":
      if (!["string", "number", "boolean"].includes(typeof json.value)) throw new Unsupported(`a ${typeof json.value} literal at ${at}`);
      return;
    case "array": return checkSupported(json.value, `${at}[]`);
    case "object": for (const [k, f] of Object.entries(json.value)) checkSupported(f.fieldType, `${at}.${k}`); return;
    case "record": checkSupported(json.keys, `${at} keys`); return checkSupported(json.values.fieldType, `${at} values`);
    case "union": for (const m of json.value) checkSupported(m, at); return;
    default: throw new Unsupported(`the ${(json as { type: string }).type} validator at ${at}`);
  }
}

/**
 * The first mismatch, or undefined if `value` fits. Messages name the path and
 * the expected type, never the value (args can carry secrets).
 */
export function mismatch(json: ValidatorJson, value: unknown, isId: (table: string, id: string) => boolean, at = "value"): string | undefined {
  const fail = (expected: string) => `${at} must be ${expected}`;
  switch (json.type) {
    case "any": return isPlain(value) ? undefined : fail("a plain JSON value");
    case "null": return value === null ? undefined : fail("null");
    case "number": return typeof value === "number" ? undefined : fail("a number");
    case "boolean": return typeof value === "boolean" ? undefined : fail("a boolean");
    case "string": return typeof value === "string" ? undefined : fail("a string");
    case "id": return typeof value === "string" && isId(json.tableName, value) ? undefined : fail(`an id in table ${json.tableName}`);
    case "literal": return value === json.value ? undefined : fail(`the literal ${JSON.stringify(json.value)}`);
    case "array": {
      if (!Array.isArray(value)) return fail("an array");
      for (let i = 0; i < value.length; i++) {
        const m = mismatch(json.value, value[i], isId, `${at}[${i}]`);
        if (m) return m;
      }
      return undefined;
    }
    case "object": {
      if (!isObject(value)) return fail("an object");
      for (const k of Object.keys(value)) {
        if (!(k in json.value) && value[k] !== undefined) return `${at} has an unexpected field ${JSON.stringify(k)}`;
      }
      for (const [k, f] of Object.entries(json.value)) {
        const v = value[k];
        if (v === undefined) {
          if (!f.optional) return `${at}.${k} is required`;
          continue;
        }
        const m = mismatch(f.fieldType, v, isId, `${at}.${k}`);
        if (m) return m;
      }
      return undefined;
    }
    case "record": {
      if (!isObject(value)) return fail("an object");
      for (const [k, v] of Object.entries(value)) {
        const m = mismatch(json.keys, k, isId, `${at} key`) ?? mismatch(json.values.fieldType, v, isId, `${at}.${k}`);
        if (m) return m;
      }
      return undefined;
    }
    case "union":
      return json.value.some((m) => mismatch(m, value, isId, at) === undefined) ? undefined : fail("one of the union's members");
    default:
      throw new Unsupported(`the ${(json as { type: string }).type} validator at ${at}`);
  }
}

export function isObject(value: unknown): value is Record<string, Value> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function isPlain(value: unknown): boolean {
  if (value === null || value === undefined || typeof value === "boolean" || typeof value === "string") return true;
  if (typeof value === "number") return true;
  if (Array.isArray(value)) return value.every(isPlain);
  return isObject(value) && Object.values(value).every(isPlain);
}

// ---------------------------------------------------------------------------
// Ordering: Convex's total order across types, then within a type.
// undefined < null < number < boolean < string < array < object.

const RANK = { undefined: 0, null: 1, number: 2, boolean: 3, string: 4, array: 5, object: 6 } as const;

function rank(v: unknown): number {
  if (v === undefined) return RANK.undefined;
  if (v === null) return RANK.null;
  if (typeof v === "number") return RANK.number;
  if (typeof v === "boolean") return RANK.boolean;
  if (typeof v === "string") return RANK.string;
  if (Array.isArray(v)) return RANK.array;
  if (isObject(v)) return RANK.object;
  throw new Unsupported(`comparing a ${typeof v}`);
}

const utf8 = new TextEncoder();

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
  return a.length - b.length;
}

export function compareValues(a: unknown, b: unknown): number {
  const ra = rank(a);
  const rb = rank(b);
  if (ra !== rb) return ra - rb;
  if (typeof a === "number" || typeof a === "boolean") return compareBytes(scalarBytes(a), scalarBytes(b as number | boolean));
  if (typeof a === "string") return compareBytes(utf8.encode(a), utf8.encode(b as string));
  if (Array.isArray(a)) {
    const bb = b as unknown[];
    for (let i = 0; i < Math.min(a.length, bb.length); i++) {
      const c = compareValues(a[i], bb[i]);
      if (c !== 0) return c;
    }
    return a.length - bb.length;
  }
  if (isObject(a)) {
    const ea = Object.entries(a).filter(([, v]) => v !== undefined).sort(([x], [y]) => compareValues(x, y));
    const eb = Object.entries(b as object).filter(([, v]) => v !== undefined).sort(([x], [y]) => compareValues(x, y));
    for (let i = 0; i < Math.min(ea.length, eb.length); i++) {
      const c = compareValues(ea[i]![0], eb[i]![0]) || compareValues(ea[i]![1], eb[i]![1]);
      if (c !== 0) return c;
    }
    return ea.length - eb.length;
  }
  return 0;
}

function scalarBytes(v: number | boolean): Uint8Array {
  if (typeof v === "boolean") return Uint8Array.of(v ? 1 : 0);
  const buf = new DataView(new ArrayBuffer(8));
  buf.setFloat64(0, Object.is(v, -0) ? -0 : v);
  // IEEE 754 to an unsigned order: flip the sign bit of positives, every bit of negatives.
  const hi = buf.getUint32(0);
  if (hi & 0x8000_0000) {
    buf.setUint32(0, ~hi >>> 0);
    buf.setUint32(4, ~buf.getUint32(4) >>> 0);
  } else {
    buf.setUint32(0, (hi | 0x8000_0000) >>> 0);
  }
  return new Uint8Array(buf.buffer);
}

// ---------------------------------------------------------------------------
// Index keys: each field's encoding is self-delimiting, starts with a type tag
// below 0xff and sorts as compareValues does, so the concatenation sorts as the
// tuple and `prefix + 0xff` bounds everything that starts with `prefix`.

const TAG = { undefined: 0x01, null: 0x02, number: 0x03, boolean: 0x04, string: 0x05 } as const;
export const KEY_END = 0xff;

export function encodeKeyPart(v: unknown, field: string): Uint8Array {
  if (v === undefined) return Uint8Array.of(TAG.undefined);
  if (v === null) return Uint8Array.of(TAG.null);
  if (typeof v === "number") return concat([Uint8Array.of(TAG.number), scalarBytes(v)]);
  if (typeof v === "boolean") return Uint8Array.of(TAG.boolean, v ? 1 : 0);
  if (typeof v === "string") {
    // 0x00 is escaped as 0x00 0xff; the string ends with 0x00 0x00.
    const raw = utf8.encode(v);
    const out: number[] = [TAG.string];
    for (const byte of raw) {
      out.push(byte);
      if (byte === 0) out.push(0xff);
    }
    out.push(0, 0);
    return Uint8Array.from(out);
  }
  throw new Unsupported(`an index on ${field} holding a ${Array.isArray(v) ? "array" : typeof v}`);
}

export function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** A document's field at a dotted path (`home.machine`). */
export function fieldAt(doc: Record<string, unknown>, path: string): unknown {
  let v: unknown = doc;
  for (const part of path.split(".")) {
    if (!isObject(v)) return undefined;
    v = v[part];
  }
  return v;
}

// ---------------------------------------------------------------------------
// Copies and storage. Values cross into and out of functions as copies (as over
// the wire): undefined object fields are dropped, non-finite numbers and -0 kept.

export function copyValue<T>(value: T, at = "value"): T {
  return copy(value, at) as T;
}

function copy(v: unknown, at: string): unknown {
  if (v === null || v === undefined || typeof v === "string" || typeof v === "number" || typeof v === "boolean") return v;
  if (Array.isArray(v)) {
    return v.map((x, i) => {
      if (x === undefined) throw new Error(`${at}[${i}] is undefined, which isn't a Convex value`);
      return copy(x, `${at}[${i}]`);
    });
  }
  if (isObject(v)) {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) if (x !== undefined) out[k] = copy(x, `${at}.${k}`);
    return out;
  }
  if (typeof v === "bigint") throw new Unsupported(`bigint values (${at})`);
  throw new Error(`${at} isn't a Convex value (${typeof v})`);
}

// Convex field names can't start with "$", so {"$f": ...} can't collide with a document field.
const SPECIAL: Record<string, number> = { NaN: Number.NaN, Infinity: Number.POSITIVE_INFINITY, "-Infinity": Number.NEGATIVE_INFINITY, "-0": -0 };

export function toStored(value: unknown): string {
  return JSON.stringify(value, (_k, v) => (typeof v === "number" && (!Number.isFinite(v) || Object.is(v, -0)) ? { $f: Object.is(v, -0) ? "-0" : String(v) } : v));
}

export function fromStored<T>(text: string): T {
  return JSON.parse(text, (_k, v) => (isObject(v) && Object.keys(v).length === 1 && typeof v.$f === "string" && v.$f in SPECIAL ? SPECIAL[v.$f] : v)) as T;
}
