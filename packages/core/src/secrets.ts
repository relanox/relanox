import type { SecretRef } from "@relanox/sdk";
import { z } from "zod";

export const secretRefSchema = z.strictObject({
  env: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/u),
});

/** Called by assembly/plugins at the point of use, never by durable snapshot creation. */
export function resolveSecretRef(
  ref: SecretRef,
  environment: Readonly<Record<string, string | undefined>>,
): string {
  const { env } = secretRefSchema.parse(ref);
  const value = environment[env];
  if (!value) {
    throw new Error(`Missing environment secret: ${env}`);
  }
  return value;
}
