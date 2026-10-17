import { DWClient } from 'dingtalk-stream'
import type { DWClientDownStream } from 'dingtalk-stream'
import type { ChannelHost } from '@relanox/sdk'
import type { DingTalkConfig } from './config.js'
import { secret } from './transport.js'

/** Observe SDK state without replacing its heartbeat, queue or recovery policy. */
export class DingTalkStream extends DWClient {
  constructor(
    config: DingTalkConfig,
    private readonly host: ChannelHost,
    receive: (frame: DWClientDownStream) => Promise<void>
  ) {
    super({
      clientId: config.clientId,
      clientSecret: secret(config.clientSecret),
      ua: 'relanox-node/0.1.0',
      debug: false,
      keepAlive: true,
      subscriptions: []
    })
    this.registerCallbackListener('/v1.0/im/bot/messages/get', receive)
  }

  override onSystem(
    frame: DWClientDownStream,
    socket?: Parameters<DWClient['onSystem']>[1]
  ): void {
    super.onSystem(frame, socket)
    if (frame.headers.topic === 'REGISTERED') {
      this.host.connection('connected')
    } else if (frame.headers.topic === 'disconnect') {
      this.host.connection('disconnected')
    }
  }
}
