import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { MediaDownloadError } from "./errors.js";

const excludedRanges = [
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

function ipv4Number(address: string): number {
  return address.split(".").reduce((value, part) => value * 256 + Number(part), 0);
}

const excludedBounds = excludedRanges.map(([address, prefix]) => {
  const start = ipv4Number(address);
  return { start, end: start + 2 ** (32 - prefix) };
});

function isPublicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const value = ipv4Number(address);
    return !excludedBounds.some(({ start, end }) => value >= start && value < end);
  }
  if (isIP(address) !== 6) {
    return false;
  }
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

/** DNS answers are checked together and the selected address is pinned for the actual request. */
export async function resolveMediaAddress(hostname: string, trusted: boolean, signal: AbortSignal) {
  let onAbort: (() => void) | undefined;

  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => {
      reject(new MediaDownloadError("media_timeout"));
    };
    if (signal.aborted) {
      onAbort();
    } else {
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });

  try {
    const addresses = await Promise.race([
      isIP(hostname) === 0
        ? lookup(hostname, { all: true, order: "verbatim" })
        : Promise.resolve([{ address: hostname, family: isIP(hostname) }]),
      aborted,
    ]);

    const address = addresses[0];
    if (
      !address ||
      (!trusted && addresses.some((candidate) => !isPublicAddress(candidate.address)))
    ) {
      throw new MediaDownloadError("forbidden_destination");
    }
    return address;
  } finally {
    if (onAbort) {
      signal.removeEventListener("abort", onAbort);
    }
  }
}
