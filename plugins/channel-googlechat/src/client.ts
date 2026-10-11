import type { SendResult } from "@relanox/sdk";
import { importPKCS8, SignJWT } from "jose";
import type { GoogleChatConfig } from "./config.js";
import { validateEndpointUrl } from "./config.js";
import { failure, request, secret } from "./io.js";
import { oauthTokenResponseSchema, serviceSchema } from "./schemas.js";

export async function accessToken(
  config: GoogleChatConfig,
  signal: AbortSignal,
): Promise<string | SendResult> {
  const service = serviceSchema.parse(JSON.parse(secret(config.serviceAccount)) as unknown);
  const key = await importPKCS8(service.private_key, "RS256");

  const assertion = await new SignJWT({ scope: "https://www.googleapis.com/auth/chat.bot" })
    .setProtectedHeader({ alg: "RS256" })
    .setIssuer(service.client_email)
    .setAudience(config.tokenUrl)
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(key);

  const response = await request(
    validateEndpointUrl(config.tokenUrl, config.allowLoopback),
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion,
      }),
    },
    signal,
  );

  if (!response.ok) {
    return response.status >= 500
      ? { status: "retryable", errorCode: "oauth_unavailable" }
      : failure(response);
  }
  return oauthTokenResponseSchema.parse(await response.json()).access_token;
}
