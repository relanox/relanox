export async function rawBody(incoming: Request): Promise<Uint8Array> {
  const bytes = new Uint8Array(await incoming.arrayBuffer())
  if (bytes.length > 2_097_152) {
    throw new Error('body_too_large')
  }
  return bytes
}

export function parseBody(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    ) as unknown
  } catch {
    return undefined
  }
}

export async function request(
  url: URL,
  init: RequestInit,
  signal?: AbortSignal
): Promise<Response> {
  const deadline = AbortSignal.timeout(10_000)
  const bounded = signal ? AbortSignal.any([signal, deadline]) : deadline
  return fetch(url, { ...init, signal: bounded, redirect: 'error' })
}
