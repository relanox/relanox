import { isPublicAddress } from '@relanox/transport'
import type { LookupAddress } from 'node:dns'
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { MediaDownloadError } from './errors.js'

/** DNS answers are checked together and the selected address is pinned for the actual request. */
export async function resolveMediaAddress(
  hostname: string,
  trusted: boolean,
  signal: AbortSignal
): Promise<LookupAddress> {
  let onAbort: (() => void) | undefined

  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = (): void => {
      reject(new MediaDownloadError('media_timeout'))
    }
    if (signal.aborted) {
      onAbort()
    } else {
      signal.addEventListener('abort', onAbort, { once: true })
    }
  })

  try {
    const addresses = await Promise.race([
      isIP(hostname) === 0
        ? lookup(hostname, { all: true, order: 'verbatim' })
        : Promise.resolve([{ address: hostname, family: isIP(hostname) }]),
      aborted
    ])

    const address = addresses[0]
    if (
      !address ||
      (!trusted &&
        addresses.some((candidate) => !isPublicAddress(candidate.address)))
    ) {
      throw new MediaDownloadError('forbidden_destination')
    }
    return address
  } finally {
    if (onAbort) {
      signal.removeEventListener('abort', onAbort)
    }
  }
}
