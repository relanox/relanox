import { expect, it } from 'vitest'
import { createMatrixChannel } from '../src/index.js'
import { harness, httpPeer, json } from './harness.js'

// Matrix-js-sdk 43.0.0:
// Src/http-api/errors.ts HTTPError/MatrixError.getRetryAfterMs.
// https://spec.matrix.org/v1.19/client-server-api/#rate-limiting
it.each(['http-date', 'body-only', 'header-precedence', 'past-date'] as const)(
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

      const header = {
        'http-date': new Date(availableAt).toUTCString(),
        'header-precedence': '7',
        'past-date': 'Thu, 01 Jan 1970 00:00:00 GMT',
        'body-only': undefined
      }[mode]

      if (header !== undefined) {
        response.setHeader('Retry-After', header)
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
      const expected = {
        'body-only': 12_500,
        'header-precedence': 7000,
        'past-date': 0
      }

      expect(result.retryAfterMs).toBe(expected[mode])
    }
  }
)
