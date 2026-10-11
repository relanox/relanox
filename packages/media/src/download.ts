import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { IncomingMessage } from "node:http";
import { resolveMediaAddress } from "./address.js";
import { MediaDownloadError } from "./errors.js";

export interface DownloadMediaOptions {
  readonly maxBytes: number;
  readonly signal: AbortSignal;
  /** Exact origins derived from administrator-configured API endpoints, never message data. */
  readonly trustedOrigins?: readonly string[];
  readonly allowInsecureLocalhost?: boolean;
  /** Credentials are sent only to an exact trusted origin. Redirects are never followed. */
  readonly headers?: Readonly<Record<string, string>>;
}

export interface DownloadedMedia {
  readonly data: Uint8Array;
  readonly mimeType: string;
}

function validateUrl(value: string, options: DownloadMediaOptions) {
  const url = new URL(value);
  const trusted = options.trustedOrigins?.includes(url.origin) === true;
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    url.username ||
    url.password ||
    url.hash ||
    (url.protocol !== "https:" &&
      !(url.protocol === "http:" && trusted && loopback && options.allowInsecureLocalhost)) ||
    (!trusted && Object.keys(options.headers ?? {}).length > 0)
  ) {
    throw new MediaDownloadError("forbidden_destination");
  }
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes <= 0) {
    throw new MediaDownloadError("media_too_large");
  }
  return { url, trusted };
}

async function consume(response: IncomingMessage, maximum: number): Promise<DownloadedMedia> {
  const status = response.statusCode ?? 500;
  if (status < 200 || status >= 300) {
    response.destroy();
    throw new MediaDownloadError("media_download_failed", status);
  }
  const declared = response.headers["content-length"];
  if (declared !== undefined && Number(declared) > maximum) {
    response.destroy();
    throw new MediaDownloadError("media_too_large");
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const part of response) {
    const bytes = part as Buffer;
    size += bytes.byteLength;
    if (size > maximum) {
      response.destroy();
      throw new MediaDownloadError("media_too_large");
    }
    chunks.push(bytes);
  }
  return {
    data: Buffer.concat(chunks, size),
    mimeType:
      (response.headers["content-type"] ?? "application/octet-stream")
        .split(";")[0]
        ?.trim()
        .toLowerCase() ?? "application/octet-stream",
  };
}

/** Bounded binary download with DNS pinning, normal TLS validation, and no redirect credential leaks. */
export async function downloadMedia(
  value: string,
  options: DownloadMediaOptions,
): Promise<DownloadedMedia> {
  const { url, trusted } = validateUrl(value, options);
  const signal = AbortSignal.any([options.signal, AbortSignal.timeout(120_000)]);
  try {
    const address = await resolveMediaAddress(
      url.hostname.replaceAll(/^\[|\]$/gu, ""),
      trusted,
      signal,
    );

    return await new Promise((resolve, reject) => {
      const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(
        url,
        {
          method: "GET",
          headers: { ...options.headers, "Accept-Encoding": "identity" },
          signal,
          agent: false,
          lookup: (_hostname, lookupOptions, done) => {
            if (lookupOptions.all === true) {
              done(null, [address]);
            } else {
              done(null, address.address, address.family);
            }
          },
        },
        (response) => {
          void consume(response, options.maxBytes).then(resolve, reject);
        },
      );

      request.on("error", reject);
      request.end();
    });
  } catch (error) {
    if (error instanceof MediaDownloadError) {
      throw error;
    }
    throw new MediaDownloadError(signal.aborted ? "media_timeout" : "media_download_failed");
  }
}
