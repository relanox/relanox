import { expect, it, vi } from 'vitest'
import { createMatrixChannel } from '../src/index.js'
import { cleanup, harness, httpPeer, json } from './harness.js'

const months = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec'
]

const weekdays = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday'
]

// RFC 9110 section 5.6.7 specifies these exact obsolete HTTP-date forms and UTC.
// https://www.rfc-editor.org/rfc/rfc9110.html#section-5.6.7
function obsoleteDate(timestamp: number, form: 'rfc850' | 'asctime'): string {
  const date = new Date(timestamp)
  const weekday = weekdays[date.getUTCDay()]
  const month = months[date.getUTCMonth()]
  if (weekday === undefined || month === undefined) {
    throw new Error('Invalid date fixture')
  }
  const time = date.toISOString().slice(11, 19)
  if (form === 'rfc850') {
    return `${weekday}, ${String(date.getUTCDate()).padStart(2, '0')}-${month}-${String(date.getUTCFullYear()).slice(-2)} ${time} GMT`
  }
  return `${weekday.slice(0, 3)} ${month} ${String(date.getUTCDate()).padStart(2, ' ')} ${time} ${date.getUTCFullYear()}`
}

function nonUtcTimezone(): void {
  vi.stubEnv('TZ', 'Pacific/Honolulu')
  cleanup(async () => {
    vi.unstubAllEnvs()
  })
}

async function limitedSend(header: string): Promise<number> {
  const peer = await httpPeer((request, response) => {
    if (request.url?.includes('/state/')) {
      json(response, { errcode: 'M_NOT_FOUND' }, 404)
      return
    }
    response.setHeader('Retry-After', header)
    json(
      response,
      {
        errcode: 'M_LIMIT_EXCEEDED',
        error: 'Too many requests',
        retry_after_ms: 12_500
      },
      429
    )
  })

  const plugin = createMatrixChannel({ MATRIX_TOKEN: 'matrix-secret' })
  await harness(
    plugin,
    {
      homeserver: peer.base,
      accessToken: { env: 'MATRIX_TOKEN' },
      allowInsecureLocalhost: true
    },
    [{ chatId: '!room:example.org' }],
    ['@alice:example.org'],
    `${peer.base}/dispatch`
  )

  const result = await plugin.send({
    deliveryId: 'rate-limited-delivery',
    channelId: 'authorized-channel',
    target: {
      channel: 'matrix',
      accountId: 'bot',
      chatId: '!room:example.org',
      data: { homeserver: peer.base, userId: '@bot:local.test' }
    },
    chunk: { text: 'answer', idempotencyKey: 'rate-limited:0', state: null },
    chunkIndex: 0,
    signal: new AbortController().signal
  })

  expect(result).toMatchObject({
    status: 'retryable',
    errorCode: 'rate_limited'
  })
  if (result.status !== 'retryable' || result.retryAfterMs === undefined) {
    throw new Error('Missing native retry delay')
  }
  return result.retryAfterMs
}

it.each(['rfc850', 'asctime'] as const)(
  'honors obsolete %s Retry-After as UTC through a native HTTP send',
  async (form) => {
    nonUtcTimezone()
    const availableAt = Math.ceil(Date.now() / 1000) * 1000 + 60_000
    const before = Date.now()
    const retryAfterMs = await limitedSend(obsoleteDate(availableAt, form))
    const after = Date.now()
    expect(retryAfterMs).toBeGreaterThanOrEqual(availableAt - after)
    expect(retryAfterMs).toBeLessThanOrEqual(availableAt - before)
  }
)

it.each(['inside', 'outside'] as const)(
  'uses the RFC850 timestamp rule %s the 50-year future boundary',
  async (position) => {
    const future = new Date(Math.floor(Date.now() / 1000) * 1000)
    future.setUTCFullYear(future.getUTCFullYear() + 50)
    future.setUTCSeconds(
      future.getUTCSeconds() + (position === 'inside' ? -60 : 60)
    )
    const represented = new Date(future)
    if (position === 'outside') {
      represented.setUTCFullYear(represented.getUTCFullYear() - 100)
    }
    const before = Date.now()

    const retryAfterMs = await limitedSend(
      obsoleteDate(represented.getTime(), 'rfc850')
    )

    const after = Date.now()
    if (position === 'outside') {
      expect(retryAfterMs).toBe(0)
    } else {
      expect(retryAfterMs).toBeGreaterThanOrEqual(future.getTime() - after)
      expect(retryAfterMs).toBeLessThanOrEqual(future.getTime() - before)
    }
  }
)

it.each([
  'Invalid Date',
  '1994-11-06T08:49:37Z',
  'Sun Nov  6 08:49:37 1994 GMT',
  'Sunday, 06-Nov-1994 08:49:37 GMT',
  'Sunday, 32-Nov-94 08:49:37 GMT'
])('falls back to native metadata for invalid HTTP-date %s', async (header) => {
  expect(await limitedSend(header)).toBe(12_500)
})

it.each([
  'Sunday, 06-Nov-94 08:49:37 GMT',
  'Sun Nov  6 08:49:37 1994',
  'Sat, 31 Dec 2016 23:59:60 GMT'
])(
  'uses a valid past HTTP-date %s instead of native body metadata',
  async (header) => {
    expect(await limitedSend(header)).toBe(0)
  }
)

// Matrix JS SDK d633e7c1954a6b92597fbc3f8a95f183789a8d40:
// Src/http-api/errors.ts HTTPError/MatrixError.getRetryAfterMs.
// https://spec.matrix.org/v1.19/client-server-api/#rate-limiting
it.each(['http-date', 'body-only', 'header-precedence'] as const)(
  'respects native Matrix rate-limit timing from %s through the HTTP send boundary',
  async (mode) => {
    const availableAt = Math.ceil(Date.now() / 1000) * 1000 + 60_000
    let sends = 0

    const peer = await httpPeer((request, response) => {
      if (request.url?.includes('/state/')) {
        json(response, { errcode: 'M_NOT_FOUND' }, 404)
        return
      }
      sends += 1
      if (mode !== 'body-only') {
        response.setHeader(
          'Retry-After',
          mode === 'http-date' ? new Date(availableAt).toUTCString() : '7'
        )
      }
      json(
        response,
        {
          errcode: 'M_LIMIT_EXCEEDED',
          error: 'Too many requests',
          retry_after_ms: 12_500
        },
        429
      )
    })

    const plugin = createMatrixChannel({ MATRIX_TOKEN: 'matrix-secret' })
    await harness(
      plugin,
      {
        homeserver: peer.base,
        accessToken: { env: 'MATRIX_TOKEN' },
        allowInsecureLocalhost: true
      },
      [{ chatId: '!room:example.org' }],
      ['@alice:example.org'],
      `${peer.base}/dispatch`
    )
    const before = Date.now()

    const result = await plugin.send({
      deliveryId: 'rate-limited-delivery',
      channelId: 'authorized-channel',
      target: {
        channel: 'matrix',
        accountId: 'bot',
        chatId: '!room:example.org',
        data: { homeserver: peer.base, userId: '@bot:local.test' }
      },
      chunk: { text: 'answer', idempotencyKey: 'rate-limited:0', state: null },
      chunkIndex: 0,
      signal: new AbortController().signal
    })

    const after = Date.now()
    expect(sends).toBe(1)
    expect(result).toMatchObject({
      status: 'retryable',
      errorCode: 'rate_limited'
    })
    if (result.status !== 'retryable' || result.retryAfterMs === undefined) {
      throw new Error('Missing native retry delay')
    }
    if (mode === 'http-date') {
      expect(result.retryAfterMs).toBeGreaterThanOrEqual(availableAt - after)
      expect(result.retryAfterMs).toBeLessThanOrEqual(availableAt - before)
    } else {
      expect(result.retryAfterMs).toBe(mode === 'body-only' ? 12_500 : 7000)
    }
  }
)
