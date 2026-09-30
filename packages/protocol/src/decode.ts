// A small structural decoder for untrusted JSON: enough to validate loopback
// requests without a dependency. Each decoder returns the value or throws a
// DecodeError naming the path that failed.

export class DecodeError extends Error {
  readonly path: string;
  constructor(path: string, expected: string) {
    super(`${path || "body"}: expected ${expected}`);
    this.name = "DecodeError";
    this.path = path;
  }
}

export type Decoder<T> = (value: unknown, path: string) => T;

export type Decoded<D> = D extends Decoder<infer T> ? T : never;

export function decode<T>(decoder: Decoder<T>, value: unknown): { ok: true; value: T } | { ok: false; error: string } {
  try {
    return { ok: true, value: decoder(value, "") };
  } catch (error) {
    if (error instanceof DecodeError) return { ok: false, error: error.message };
    throw error;
  }
}

export const string =
  (options: { min?: number; max?: number; pattern?: RegExp; label?: string } = {}): Decoder<string> =>
  (value, path) => {
    const expected = options.label ?? "a string";
    if (typeof value !== "string") throw new DecodeError(path, expected);
    if (options.min !== undefined && value.length < options.min) throw new DecodeError(path, expected);
    if (options.max !== undefined && value.length > options.max) throw new DecodeError(path, expected);
    if (options.pattern && !options.pattern.test(value)) throw new DecodeError(path, expected);
    return value;
  };

export const integer =
  (options: { min?: number; max?: number } = {}): Decoder<number> =>
  (value, path) => {
    const range = `an integer${options.min !== undefined ? ` >= ${options.min}` : ""}${options.max !== undefined ? ` <= ${options.max}` : ""}`;
    if (typeof value !== "number" || !Number.isInteger(value)) throw new DecodeError(path, range);
    if (options.min !== undefined && value < options.min) throw new DecodeError(path, range);
    if (options.max !== undefined && value > options.max) throw new DecodeError(path, range);
    return value;
  };

export const literal =
  <const T extends string>(...values: T[]): Decoder<T> =>
  (value, path) => {
    if (typeof value !== "string" || !(values as string[]).includes(value)) {
      throw new DecodeError(path, values.map((v) => JSON.stringify(v)).join(" | "));
    }
    return value as T;
  };

export const array =
  <T>(item: Decoder<T>, options: { max?: number } = {}): Decoder<T[]> =>
  (value, path) => {
    if (!Array.isArray(value)) throw new DecodeError(path, "an array");
    if (options.max !== undefined && value.length > options.max) {
      throw new DecodeError(path, `an array of at most ${options.max}`);
    }
    return value.map((v, i) => item(v, `${path}[${i}]`));
  };

type Field<T> = { decoder: Decoder<T>; optional: boolean };

export function optional<T>(decoder: Decoder<T>): Field<T> {
  return { decoder, optional: true };
}

type Shape = Record<string, Decoder<unknown> | Field<unknown>>;

type ShapeValue<S extends Shape> = {
  [K in keyof S as S[K] extends Field<unknown> ? never : K]: S[K] extends Decoder<infer T> ? T : never;
} & {
  [K in keyof S as S[K] extends Field<unknown> ? K : never]?: S[K] extends Field<infer T> ? T : never;
};

/** An object with exactly these fields; unknown fields are ignored and not copied. */
export const object =
  <S extends Shape>(shape: S): Decoder<{ [K in keyof ShapeValue<S>]: ShapeValue<S>[K] }> =>
  (value, path) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new DecodeError(path, "an object");
    const input = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [key, spec] of Object.entries(shape)) {
      const field: Field<unknown> = typeof spec === "function" ? { decoder: spec, optional: false } : spec;
      const fieldPath = path ? `${path}.${key}` : key;
      if (input[key] === undefined) {
        if (field.optional) continue;
        throw new DecodeError(fieldPath, "a value");
      }
      out[key] = field.decoder(input[key], fieldPath);
    }
    return out as never;
  };

/** A tagged union: picks the decoder by the value of `tag`. */
export const tagged =
  <K extends string, M extends Record<string, Decoder<unknown>>>(
    tag: K,
    members: M,
  ): Decoder<{ [T in keyof M]: M[T] extends Decoder<infer V> ? V : never }[keyof M]> =>
  (value, path) => {
    const tagPath = path ? `${path}.${tag}` : tag;
    if (typeof value !== "object" || value === null) throw new DecodeError(path, "an object");
    const key = (value as Record<string, unknown>)[tag];
    const decoder = typeof key === "string" ? members[key] : undefined;
    if (!decoder) throw new DecodeError(tagPath, Object.keys(members).map((k) => JSON.stringify(k)).join(" | "));
    return decoder(value, path) as never;
  };
