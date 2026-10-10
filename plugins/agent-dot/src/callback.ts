import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { z } from "zod";

export const callbackConfig = z.strictObject({
  allowedOrigins: z.array(z.url()).min(1).max(100),
  transport: z.enum(["public-https", "loopback-http"]).default("public-https"),
  timeoutMs: z.number().int().min(100).max(30_000).default(10_000),
});
export type CallbackConfig = z.infer<typeof callbackConfig>;
export class CallbackError extends Error {
  constructor(
    readonly reason: "forbidden_destination" | "timeout" | "network_error" | "response_too_large",
  ) {
    super(reason);
    this.name = "CallbackError";
  }
}
export function callbackUrl(value: string, config: CallbackConfig): URL {
  const url = new URL(value);
  if (url.username || url.password || url.hash || !config.allowedOrigins.includes(url.origin)) {
    throw new CallbackError("forbidden_destination");
  }
  const loopback = ["127.0.0.1", "[::1]"].includes(url.hostname);
  if (config.transport === "loopback-http") {
    if (!loopback || url.protocol !== "http:") {
      throw new CallbackError("forbidden_destination");
    }
  } else if (url.protocol !== "https:") {
    throw new CallbackError("forbidden_destination");
  }
  return url;
}
function ipv4Number(address: string): number {
  return address.split(".").reduce((value, part) => value * 256 + Number(part), 0);
}
const excludedIpv4Ranges = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 16],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 3],
] as const;
const excludedIpv4Bounds = excludedIpv4Ranges.map(([address, prefix]) => {
  const start = ipv4Number(address);
  return { start, end: start + 2 ** (32 - prefix) };
});
/** Conservative global-unicast policy; mapped, transition and documentation ranges are excluded. */
export function isPublicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const value = ipv4Number(address);
    return !excludedIpv4Bounds.some(({ start, end }) => value >= start && value < end);
  }
  if (isIP(address) === 6) {
    const normalized = new URL(`http://[${address}]/`).hostname.slice(1, -1).toLowerCase();
    const [firstPart = "0", secondPart = "0"] = normalized.split(":");
    const first = Number.parseInt(firstPart, 16);
    const second = Number.parseInt(secondPart || "0", 16);
    return (
      first >= 0x20_00 &&
      first <= 0x3f_ff &&
      !normalized.startsWith("2001:db8:") &&
      !(first === 0x20_01 && second < 0x02_00) &&
      first !== 0x20_02 &&
      first !== 0x3f_ff
    );
  }
  return false;
}
/** Resolve immediately before connecting and pin that address; TLS still verifies the original hostname. */
export async function postCallback(
  urlValue: string,
  config: CallbackConfig,
  body: string,
  headers: Record<string, string>,
  signal: AbortSignal,
): Promise<{
  status: number;
  body: string;
  headers: Record<string, string | string[] | undefined>;
}> {
  const url = callbackUrl(urlValue, config);
  const hostname = url.hostname.replaceAll(/^\[|\]$/gu, "");
  const bound = AbortSignal.any([signal, AbortSignal.timeout(config.timeoutMs)]);
  let onAbort: (() => void) | undefined;
  async function resolveAddresses() {
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => {
        reject(new CallbackError("timeout"));
      };
      if (bound.aborted) {
        onAbort();
      } else {
        bound.addEventListener("abort", onAbort, { once: true });
      }
    });
    try {
      return await Promise.race([lookup(hostname, { all: true, order: "verbatim" }), aborted]);
    } catch (error) {
      if (error instanceof CallbackError) {
        throw error;
      }
      throw new CallbackError("network_error");
    } finally {
      if (onAbort !== undefined) {
        bound.removeEventListener("abort", onAbort);
      }
    }
  }
  const addresses =
    isIP(hostname) === 0
      ? await resolveAddresses()
      : [{ address: hostname, family: isIP(hostname) }];
  if (
    config.transport === "public-https" &&
    (addresses.length === 0 || addresses.some((v) => !isPublicAddress(v.address)))
  ) {
    throw new CallbackError("forbidden_destination");
  }
  const address = addresses[0];
  if (!address) {
    throw new CallbackError("forbidden_destination");
  }
  return new Promise((resolve, reject) => {
    const req = (url.protocol === "https:" ? httpsRequest : httpRequest)(
      url,
      {
        method: "POST",
        headers: {
          ...headers,
          "Content-Length": String(Buffer.byteLength(body)),
        },
        signal: bound,
        agent: false,
        lookup: (_host, options, done) => {
          if (options.all === true) {
            done(null, [{ address: address.address, family: address.family }]);
          } else {
            done(null, address.address, address.family);
          }
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > 16_384) {
            res.destroy();
            reject(new CallbackError("response_too_large"));
          } else {
            chunks.push(chunk);
          }
        });
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 500,
            body: Buffer.concat(chunks).toString("utf8"),
            headers: res.headers,
          });
        });
        res.on("error", () => {
          reject(new CallbackError(bound.aborted ? "timeout" : "network_error"));
        });
      },
    );
    req.on("error", () => {
      reject(new CallbackError(bound.aborted ? "timeout" : "network_error"));
    });
    req.end(body);
  });
}
