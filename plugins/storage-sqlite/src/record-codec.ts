import { createHash } from "node:crypto";

export const encode = (v: unknown): string => {
  const ancestors = new Set<object>();
  const check = (x: unknown): void => {
    if (x === null || typeof x === "string" || typeof x === "boolean") {
      return;
    }
    if (typeof x === "number" && Number.isFinite(x)) {
      return;
    }
    if (typeof x !== "object" || ancestors.has(x)) {
      throw new TypeError("Non-JSON durable value");
    }
    if (!Array.isArray(x) && Object.getPrototypeOf(x) !== Object.prototype) {
      throw new TypeError("Non-plain durable value");
    }
    ancestors.add(x);
    for (const value of Object.values(x)) {
      check(value);
    }
    ancestors.delete(x);
  };
  check(v);
  return JSON.stringify(v);
};
export const decode = <T>(v: unknown): T => JSON.parse(String(v)) as T;
export const resultDigest = (text: string): string =>
  createHash("sha256").update(text).digest("hex");
export const equal = (a: unknown, b: unknown): boolean => {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) {
      return value.map(canonical);
    }
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value)
          .toSorted(([left], [right]) => left.localeCompare(right))
          .map(([key, child]) => [key, canonical(child)]),
      );
    }
    return value;
  };
  return encode(canonical(a)) === encode(canonical(b));
};
