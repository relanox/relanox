import type { SendResult } from "@relanox/sdk";
import type { TeamsConfig } from "./config.js";
import { endpoint, failure, oauthResponse, request, secret } from "./io.js";

export async function accessToken(
  config: TeamsConfig,
  signal: AbortSignal,
): Promise<string | SendResult> {
  const response = await request(
    endpoint(config.tokenUrl, config.allowLoopback),
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: config.appId,
        client_secret: secret(config.appSecret),
        scope: "https://api.botframework.com/.default",
      }),
    },
    signal,
  );
  if (!response.ok) {
    return response.status >= 500
      ? { status: "retryable", errorCode: "oauth_unavailable" }
      : failure(response);
  }
  return oauthResponse.parse(await response.json()).access_token;
}

export function serviceUrl(value: string, config: TeamsConfig): URL {
  const url = endpoint(value, config.allowLoopback);
  if (/[?#]/u.test(url.href) || !config.trustedServiceOrigins.includes(url.origin)) {
    throw new Error("untrusted_service_origin");
  }
  return url;
}
