import { vi } from 'vitest'

/** Redirect only the external Routine network boundary; preserve real HTTP traffic and production URL validation. */
export function redirectRoutine(
  origin: string,
  hostname = 'routine.test'
): void {
  const original = globalThis.fetch
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (url.protocol !== 'https:' || url.hostname !== hostname) {
      return original(input, init)
    }
    const destination = new URL(url.pathname + url.search, origin)
    return original(
      input instanceof Request ? new Request(destination, input) : destination,
      init
    )
  })
}
