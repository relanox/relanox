import { Client4, WebSocketClient } from '@mattermost/client'
import { WebSocket as NodeWebSocket } from 'ws'
import { requestTimeoutMs } from './constants.js'

/** Bind SDK HTTP calls to the operation deadline without changing global fetch. */
export class MattermostClient extends Client4 {
  constructor(
    base: string,
    token: string,
    private readonly signal?: AbortSignal
  ) {
    super()
    this.setUrl(base)
    this.setToken(token)
    this.includeCookies = false
  }

  override getOptions(
    options: Parameters<Client4['getOptions']>[0]
  ): ReturnType<Client4['getOptions']> & Pick<RequestInit, 'redirect'> {
    const result = super.getOptions(options)
    return {
      ...result,
      redirect: 'error',
      signal: AbortSignal.any([
        AbortSignal.timeout(requestTimeoutMs),
        ...(this.signal ? [this.signal] : []),
        ...(options.signal ? [options.signal] : [])
      ])
    }
  }
}

/** The official SDK supports a Node WebSocket factory; keep transport bounds there. */
export function mattermostWebSocket(): {
  client: WebSocketClient
  close(): void
} {
  let transport: NodeWebSocket | undefined

  const client = new WebSocketClient({
    newWebSocketFn(url): WebSocket {
      transport = new NodeWebSocket(url, {
        handshakeTimeout: requestTimeoutMs,
        maxPayload: 2 * 1024 * 1024,
        followRedirects: false
      })
      // Closing an unfinished handshake emits an error after SDK handlers detach.
      transport.on('error', () => {})
      // Mattermost's documented Node transport is ws, while its factory uses DOM types.
      return transport as unknown as WebSocket
    }
  })

  return {
    client,
    close() {
      // SDK close() only closes OPEN sockets; stop also releases CONNECTING sockets.
      if (transport) {
        transport.removeAllListeners()
        transport.on('error', () => {})
      }
      client.close()
      transport?.terminate()
      transport = undefined
    }
  }
}
