import type { Json } from "@relanox/sdk";
import { z } from "zod";

/** Persist only JSON values; cloning must not materialize environment-backed secrets. */
export function jsonSnapshot<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
export function validateJson(value: unknown): Json {
  return z.json().parse(value);
}
