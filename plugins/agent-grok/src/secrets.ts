import { createHash, timingSafeEqual } from "node:crypto";
import type { SecretRef } from "@relanox/sdk";

export function resolveAgentSecret(ref: SecretRef): string {
  const value = process.env[ref.env];
  if (value === undefined || value.length === 0 || /[\r\n]/u.test(value)) {
    throw new Error("agent_secret_unavailable");
  }
  return value;
}
export function equalSecret(a: string, b: string): boolean {
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(a), digest(b));
}
