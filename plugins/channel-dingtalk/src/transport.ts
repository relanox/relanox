import type { ChannelHost, IngestInput, SendResult } from '@relanox/sdk'
import { WebSocket } from 'ws'
import type { RawData } from 'ws'
import { z } from 'zod'
import { RemoteError } from './remote-error.js'

export { RemoteError } from './remote-error.js'

export function wireText(data: RawData): string {
  if (Buffer.isBuffer(data)) {
    return data.toString('utf8')
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString('utf8')
  }
  return Buffer.from(data).toString('utf8')
}

export function secret(ref: { env: string }): string {
  const value = process.env[ref.env]
  if (!value) {
    throw new Error('missing_secret')
  }
  return value
}

/** Policy rejections discard input; storage/unknown failures must remain unacknowledged. */
export async function ingestText(
  host: ChannelHost,
  input: IngestInput
): Promise<void> {
  try {
    await host.ingest(input)
  } catch (error) {
    const rejection = z
      .object({
        code: z.enum([
          'sender_not_allowed',
          'unbound_conversation',
          'too_many_attachments',
          'media_total_too_large'
        ])
      })
      .safeParse(error)

    if (!rejection.success) {
      throw error
    }
    host.observe.log('info', 'channel_input_discarded', {
      errorCode: rejection.data.code
    })
  }
}

export async function httpJson(
  url: string,
  init: RequestInit,
  signal: AbortSignal
): Promise<unknown> {
  const response = await fetch(url, {
    ...init,
    redirect: 'error',
    signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)])
  })

  if (response.status === 429) {
    const retry = Number(response.headers.get('retry-after'))
    throw new RemoteError({
      status: 'retryable',
      errorCode: 'rate_limited',
      retryAfterMs:
        Number.isFinite(retry) && retry > 0
          ? Math.min(retry * 1000, 300_000)
          : 1000
    })
  }
  const reader = response.body?.getReader()
  if (!reader) {
    throw new Error('missing_response_body')
  }
  const parts: Uint8Array[] = []
  let size = 0
  for (;;) {
    const part = await reader.read()
    if (part.done) {
      break
    }
    size += part.value.byteLength
    if (size > 1_048_576) {
      await reader.cancel()
      throw new Error('response_too_large')
    }
    parts.push(part.value)
  }
  let body: unknown
  try {
    body = JSON.parse(Buffer.concat(parts).toString('utf8'))
  } catch {
    if (response.ok) {
      throw new Error('invalid_response_json')
    }
  }
  if (!response.ok) {
    throw new RemoteError(
      {
        status: response.status >= 500 ? 'unknown' : 'rejected',
        errorCode: `http_${response.status}`
      },
      body
    )
  }
  return body
}

export const jsonPostRequest = (
  body: unknown,
  headers: Record<string, string> = {}
): RequestInit => ({
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    accept: 'application/json',
    ...headers
  },
  body: JSON.stringify(body)
})

export const sendFailure = (error: unknown): SendResult =>
  error instanceof RemoteError
    ? error.result
    : { status: 'unknown', errorCode: 'transport_uncertain' }

/** Each account owns exactly one socket. Initialization is short; recovery uses bounded delays. */
export class JsonSocketConnection {
  socket: WebSocket | undefined
  signal: AbortSignal = AbortSignal.abort()
  private abortListener: (() => void) | undefined
  private controller: AbortController | undefined
  private reconnect: ReturnType<typeof setTimeout> | undefined
  private heartbeat: ReturnType<typeof setInterval> | undefined
  private authenticationDeadline: ReturnType<typeof setTimeout> | undefined
  private attempts = 0
  private queued = 0
  private active = false

  constructor(
    readonly host: ChannelHost,
    readonly url: (signal: AbortSignal) => Promise<string>,
    readonly onOpen: () => Promise<void>,
    readonly onFrame: (frame: unknown, socket: WebSocket) => Promise<void>,
    readonly onClose: (code?: number) => void,
    readonly maxAttempts: number
  ) {}

  async start(signal: AbortSignal): Promise<void> {
    if (this.active) {
      throw new Error('already_started')
    }
    signal.throwIfAborted()
    this.active = true
    this.attempts = 0
    this.controller = new AbortController()
    this.signal = AbortSignal.any([signal, this.controller.signal])
    this.abortListener = (): void => {
      void this.stop()
    }
    this.signal.addEventListener('abort', this.abortListener, { once: true })
    try {
      await this.connect()
    } catch {
      this.host.connection('degraded', 'connection_failed')
      this.schedule()
    }
  }

  private schedule(): void {
    if (!this.active || this.signal.aborted || this.reconnect) {
      return
    }
    if (this.attempts >= this.maxAttempts) {
      this.host.connection('degraded', 'reconnect_exhausted')
      return
    }
    const delay = Math.min(1000 * 2 ** this.attempts++, 30_000)
    this.reconnect = setTimeout(() => {
      this.reconnect = undefined
      void this.connect().catch(() => {
        this.host.connection('degraded', 'connection_failed')
        this.schedule()
      })
    }, delay)
  }

  private async connect(): Promise<void> {
    const address = await this.url(this.signal)
    this.signal.throwIfAborted()

    const socket = new WebSocket(address, {
      handshakeTimeout: 10_000,
      maxPayload: 1_048_576
    })

    this.socket = socket
    socket.on('error', () => {
      this.host.connection('degraded', 'socket_error')
    })
    socket.on('message', (bytes) => {
      if (socket !== this.socket || !this.active) {
        return
      }
      if (this.queued >= 100) {
        socket.terminate()
        return
      }
      let frame: unknown
      try {
        frame = JSON.parse(wireText(bytes))
      } catch {
        this.host.observe.log('warn', 'channel_invalid_frame')
        return
      }
      // Protocol ACK/heartbeat frames must not wait behind durable message writes.
      this.queued++
      void this.onFrame(frame, socket)
        .catch(() => {
          this.host.connection('degraded', 'frame_processing_failed')
          socket.terminate()
        })
        .finally(() => {
          this.queued--
        })
    })
    socket.on('close', (code) => {
      if (socket !== this.socket) {
        return
      }
      this.socket = undefined
      this.clearHeartbeat()
      this.onClose(code)
      this.host.connection('disconnected')
      this.schedule()
    })
    await new Promise<void>((resolve, reject) => {
      const abort = (): void => {
        socket.terminate()
        reject(new Error('aborted'))
      }

      this.signal.addEventListener('abort', abort, { once: true })

      const cleanup = (): void => {
        this.signal.removeEventListener('abort', abort)
      }

      socket.once('open', () => {
        cleanup()
        resolve()
      })
      socket.once('error', () => {
        cleanup()
        reject(new Error('socket_open_failed'))
      })
      socket.once('close', () => {
        cleanup()
        reject(new Error('socket_closed'))
      })
    })
    this.authenticationDeadline = setTimeout(() => {
      this.host.connection('degraded', 'authentication_timeout')
      socket.terminate()
    }, 10_000)
    try {
      await this.onOpen()
    } catch (error) {
      socket.terminate()
      throw error
    }
  }

  ready(): void {
    if (this.authenticationDeadline) {
      clearTimeout(this.authenticationDeadline)
    }
    this.authenticationDeadline = undefined
    this.attempts = 0
    this.host.connection('connected')
  }

  send(frame: unknown, socket: WebSocket): void {
    if (socket !== this.socket) {
      return
    }
    if (this.signal.aborted || socket.readyState !== WebSocket.OPEN) {
      throw new Error('not_connected')
    }
    socket.send(JSON.stringify(frame))
  }

  setHeartbeat(ms: number, tick: () => void): void {
    this.clearHeartbeat()
    this.heartbeat = setInterval(() => {
      try {
        tick()
      } catch {
        this.socket?.terminate()
      }
    }, ms)
  }

  private clearHeartbeat(): void {
    if (this.heartbeat) {
      clearInterval(this.heartbeat)
    }
    this.heartbeat = undefined
    if (this.authenticationDeadline) {
      clearTimeout(this.authenticationDeadline)
    }
    this.authenticationDeadline = undefined
  }

  async stop(): Promise<void> {
    this.active = false
    if (this.abortListener) {
      this.signal.removeEventListener('abort', this.abortListener)
    }
    this.controller?.abort()
    if (this.reconnect) {
      clearTimeout(this.reconnect)
    }
    this.reconnect = undefined
    this.clearHeartbeat()
    const socket = this.socket
    this.socket = undefined
    socket?.terminate()
    this.onClose()
    this.host.connection('disconnected')
  }
}
