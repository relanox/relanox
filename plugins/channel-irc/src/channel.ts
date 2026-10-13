import { ircMarkdown, splitIrcMarkdown } from './markdown.js'
import { requestTimeoutMs, reconnectDelayMs } from './constants.js'
import { randomUUID } from 'node:crypto'
import { createConnection, isIP } from 'node:net'
import type { Socket } from 'node:net'
import { connect as connectTls } from 'node:tls'
import type {
  AccountConfig,
  ChannelHost,
  ChannelPlugin,
  SendInput,
  SendResult
} from '@relanox/sdk'
import { validateConfig, nicknameSchema, channelSchema } from './config.js'
import type { IrcConfig } from './config.js'
import { delay, diagnose, ingest, secret, stopTask } from './protocol.js'
import { recipientSchema, targetSchema } from './schemas.js'
import { foldNick, parseMessage, wireLine } from './wire.js'
import type { CaseMapping, IrcMessage } from './wire.js'

const authenticationFailures = new Set([
  '904',
  '905',
  '906',
  '907',
  '433',
  'ERROR'
])

function incomingText(
  message: IrcMessage,
  ownNick: string,
  caseMapping: CaseMapping
): { sender: string; destination: string; text: string } | null {
  const sender = message.prefix?.split('!')[0]
  const destination = message.params[0]
  const text = message.params[1]
  if (
    !sender ||
    !message.prefix?.includes('!') ||
    !destination ||
    !text ||
    foldNick(sender, caseMapping) === foldNick(ownNick, caseMapping)
  ) {
    return null
  }
  return { sender, destination, text }
}

function receivedAt(message: IrcMessage): number {
  const timestamp = Date.parse(message.tags.time ?? '')
  return Number.isFinite(timestamp) && timestamp >= 0 ? timestamp : Date.now()
}

export function createIrcChannel(
  environment: Readonly<Record<string, string | undefined>> = process.env
): ChannelPlugin<IrcConfig> {
  let runtime:
    { host: ChannelHost; account: AccountConfig; config: IrcConfig } | undefined

  let task: Promise<void> | undefined
  let controller: AbortController | undefined
  let socket: Socket | undefined
  let ready = false
  let nick = ''
  let channels: string[] = []
  let caseMapping: CaseMapping = 'rfc1459'

  function fold(value: string): string {
    return foldNick(value, caseMapping)
  }

  function configured(): {
    host: ChannelHost
    account: AccountConfig
    config: IrcConfig
  } {
    if (!runtime) {
      throw new Error('not_setup')
    }
    return runtime
  }

  function write(current: Socket, value: string): void {
    current.write(wireLine(value))
  }

  async function receive(message: IrcMessage): Promise<void> {
    const { host, account, config } = configured()
    const incoming = incomingText(message, nick, caseMapping)
    if (!incoming) {
      return
    }
    const { sender, destination, text } = incoming
    if (text.startsWith('\u0001')) {
      diagnose(host, 'ctcp_unsupported')
      return
    }

    const channel = channels.find((value) => fold(value) === fold(destination))

    if (!channel && fold(destination) !== fold(nick)) {
      return
    }
    const stableAccount = message.tags.account

    const authenticated =
      typeof stableAccount === 'string' &&
      stableAccount.length > 0 &&
      stableAccount !== '*'

    if (!authenticated && !config.allowNickFallback) {
      diagnose(host, 'account_identity_required')
      return
    }
    if (!authenticated) {
      diagnose(host, 'nick_identity_fallback')
    }

    const senderId = authenticated
      ? `account:${stableAccount}`
      : `nick:${fold(sender)}`

    const recipient = channel ?? sender
    recipientSchema.parse(recipient)
    const eventId = message.tags.msgid
    await ingest(host, {
      source: {
        channel: 'irc',
        accountId: account.id,
        eventId: eventId?.length ? eventId : randomUUID()
      },
      senderId,
      text,
      receivedAt: receivedAt(message),
      target: {
        channel: 'irc',
        accountId: account.id,
        chatId: channel ?? `dm:${fold(sender)}`,
        ...(message.tags.msgid ? { replyToId: message.tags.msgid } : {}),
        data: {
          recipient,
          server: config.server,
          port: config.port,
          tls: config.tls
        }
      },
      context: null
    })
  }

  function negotiate(
    current: Socket,
    message: IrcMessage,
    offered: Set<string>
  ): void {
    const { config } = configured()
    const subcommand = message.params[1]
    const capabilities = message.params.at(-1)?.split(' ') ?? []
    if (subcommand === 'LS') {
      for (const capability of capabilities) {
        offered.add(capability.split('=')[0] ?? capability)
      }
      if (message.params[2] === '*') {
        return
      }
      if (config.sasl && !offered.has('sasl')) {
        throw new Error('sasl_unavailable')
      }

      const requested = [
        'account-tag',
        'server-time',
        'message-tags',
        ...(config.sasl ? ['sasl'] : [])
      ].filter((capability) => offered.has(capability))

      write(
        current,
        requested.length > 0 ? `CAP REQ :${requested.join(' ')}` : 'CAP END'
      )
      return
    }
    if (subcommand === 'ACK') {
      write(current, config.sasl ? 'AUTHENTICATE PLAIN' : 'CAP END')
    }
    if (subcommand === 'NAK') {
      if (config.sasl) {
        throw new Error('sasl_rejected')
      }
      write(current, 'CAP END')
    }
  }

  function authenticate(current: Socket): void {
    const { config } = configured()
    if (!config.sasl) {
      throw new Error('unexpected_sasl')
    }
    const password = secret(config.sasl.password, environment)
    if (password.includes('\0')) {
      throw new Error('invalid_secret')
    }

    const payload = Buffer.from(
      `\0${config.sasl.username}\0${password}`
    ).toString('base64')

    if (payload.length > 4096) {
      throw new Error('sasl_secret_too_large')
    }
    for (let offset = 0; offset < payload.length; offset += 400) {
      write(current, `AUTHENTICATE ${payload.slice(offset, offset + 400)}`)
    }
    if (payload.length % 400 === 0) {
      write(current, 'AUTHENTICATE +')
    }
  }

  function updateSupport(message: IrcMessage): void {
    for (const parameter of message.params.slice(1, -1)) {
      if (parameter === '-CASEMAPPING') {
        caseMapping = 'rfc1459'
      } else if (parameter.startsWith('CASEMAPPING=')) {
        const mapping = parameter.slice(12)
        if (
          mapping !== 'ascii' &&
          mapping !== 'rfc1459' &&
          mapping !== 'rfc1459-strict'
        ) {
          throw new Error('unsupported_casemapping')
        }
        caseMapping = mapping
      }
    }
  }

  async function handle(
    current: Socket,
    message: IrcMessage,
    offered: Set<string>
  ): Promise<void> {
    const { host, config } = configured()
    if (authenticationFailures.has(message.command)) {
      throw new Error('registration_or_connection_failed')
    }
    switch (message.command) {
      case 'PING': {
        write(current, `PONG :${message.params.at(-1) ?? ''}`)
        return
      }
      case 'CAP': {
        negotiate(current, message, offered)
        return
      }
      case 'AUTHENTICATE': {
        if (message.params[0] === '+') {
          authenticate(current)
        }
        return
      }
      case '903': {
        write(current, 'CAP END')
        return
      }
      case '001': {
        nick = message.params[0] ?? config.nick
        ready = true
        host.connection('connected')
        for (const channel of channels) {
          write(current, `JOIN ${channel}`)
        }
        return
      }
      case '005': {
        updateSupport(message)
        return
      }
      case 'NICK': {
        if (fold(message.prefix?.split('!')[0] ?? '') === fold(nick)) {
          nick = nicknameSchema.parse(message.params[0])
        }
        return
      }
      case 'PRIVMSG': {
        if (ready) {
          await receive(message)
        }
        break
      }
      default: {
        break
      }
    }
  }

  async function connect(signal: AbortSignal): Promise<void> {
    const { host, config } = configured()
    ready = false
    nick = config.nick
    caseMapping = 'rfc1459'

    const current: Socket = config.tls
      ? connectTls({
          host: config.server,
          port: config.port,
          ...(isIP(config.server) === 0 ? { servername: config.server } : {}),
          rejectUnauthorized: true
        })
      : createConnection({ host: config.server, port: config.port })

    socket = current
    current.setEncoding('utf8')
    current.setTimeout(120_000, () => current.destroy())
    const abort = (): Socket => current.destroy()
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) {
      abort()
    }

    const registration = setTimeout(() => {
      if (!ready) {
        current.destroy()
      }
    }, requestTimeoutMs)

    const offered = new Set<string>()
    let buffer = ''
    let queued = 0
    let pending = Promise.resolve()

    const queueLine = (line: string): void => {
      if (queued >= 100) {
        current.destroy()
        return
      }
      queued += 1
      pending = pending
        .then(async () => handle(current, parseMessage(line), offered))
        .catch(() => {
          diagnose(host, 'receive_failed')
          current.destroy()
        })
        .finally(() => {
          queued -= 1
        })
    }

    current.once(config.tls ? 'secureConnect' : 'connect', () => {
      try {
        if (config.password) {
          write(current, `PASS :${secret(config.password, environment)}`)
        }
        write(current, 'CAP LS 302')
        write(current, `NICK ${config.nick}`)
        write(current, `USER ${config.nick} 0 * :Relanox`)
      } catch {
        diagnose(host, 'registration_failed')
        current.destroy()
      }
    })
    current.on('data', (data: string) => {
      buffer += data
      const lines = buffer.split('\r\n')
      buffer = lines.pop() ?? ''
      if (Buffer.byteLength(buffer) > 16_384) {
        current.destroy()
        return
      }
      for (const line of lines) {
        if (Buffer.byteLength(line) > 16_384) {
          current.destroy()
          return
        }
        if (line.length > 0) {
          queueLine(line)
        }
      }
    })
    await new Promise<void>((resolve) => {
      current.once('close', () => {
        resolve()
      })
      current.on('error', () => {
        current.destroy()
        resolve()
      })
    })
    clearTimeout(registration)
    signal.removeEventListener('abort', abort)
    await pending
    ready = false
    host.connection('disconnected')
  }

  async function loop(signal: AbortSignal): Promise<void> {
    const { host } = configured()
    while (!signal.aborted) {
      try {
        await connect(signal)
      } catch {
        diagnose(host, 'connection_failed')
        host.connection('degraded')
      }
      await delay(reconnectDelayMs, signal)
    }
  }

  async function send(input: SendInput): Promise<SendResult> {
    const { account, config } = configured()
    const target = targetSchema.safeParse(input.target.data)
    if (
      input.target.channel !== 'irc' ||
      input.target.accountId !== account.id ||
      !target.success ||
      target.data.server !== config.server ||
      target.data.port !== config.port ||
      target.data.tls !== config.tls ||
      input.target.threadId !== undefined ||
      fold(input.target.chatId) !==
        fold(
          target.data.recipient.startsWith('#') ||
            target.data.recipient.startsWith('&')
            ? target.data.recipient
            : `dm:${target.data.recipient}`
        )
    ) {
      return { status: 'rejected', errorCode: 'target_mismatch' }
    }
    let line: string
    try {
      const text = ircMarkdown(input.chunk.text)
      line = wireLine(`PRIVMSG ${target.data.recipient} :${text}`)
    } catch {
      return { status: 'rejected', errorCode: 'invalid_irc_text' }
    }
    const current = socket
    if (!ready || !current || current.destroyed || input.signal.aborted) {
      return {
        status: 'retryable',
        errorCode: 'not_connected',
        retryAfterMs: 1000
      }
    }
    return new Promise<SendResult>((resolve) => {
      const unknown = (): void => {
        resolve({ status: 'unknown', errorCode: 'send_outcome_unknown' })
      }

      input.signal.addEventListener('abort', unknown, { once: true })
      current.once('close', unknown)
      current.write(line, (error) => {
        input.signal.removeEventListener('abort', unknown)
        current.removeListener('close', unknown)
        if (error || current.destroyed || input.signal.aborted) {
          unknown()
          return
        }
        resolve({
          status: 'sent',
          receipt: { data: { acknowledgement: 'socket_write' } }
        })
      })
    })
  }

  return {
    id: 'channel-irc',
    sdkMajor: 1,
    runtime: 'node',
    kind: 'channel',
    channel: 'irc',
    capabilities: {
      receive: true,
      transport: 'connection',
      maxTextLength: 400,
      lengthUnit: 'utf8',
      idempotentSend: false,
      media: { receive: [], send: [] }
    },
    validateConfig,
    async resolveChannel(address) {
      const { account, config } = configured()

      const recipient = address.chatId.startsWith('dm:')
        ? address.chatId.slice(3)
        : address.chatId

      if (
        address.platform !== 'irc' ||
        address.accountId !== account.id ||
        address.threadId !== undefined ||
        !(
          address.chatId.startsWith('dm:') ? nicknameSchema : channelSchema
        ).safeParse(recipient).success
      ) {
        return { status: 'unavailable', reason: 'invalid_address' }
      }
      return {
        status: 'available',
        target: {
          channel: 'irc',
          accountId: account.id,
          chatId: address.chatId,
          data: {
            recipient,
            server: config.server,
            port: config.port,
            tls: config.tls
          }
        }
      }
    },
    splitText: splitIrcMarkdown,
    async setup(host, account, config) {
      if (runtime) {
        throw new Error('already_setup')
      }
      channels = [...new Set(host.boundChatIds)]
        .filter((chatId) => chatId.startsWith('#') || chatId.startsWith('&'))
        .map((chatId) => channelSchema.parse(chatId))
      if (channels.length > 100) {
        throw new Error('too_many_bound_channels')
      }
      runtime = { host, account, config }
    },
    async start(signal) {
      if (task) {
        return
      }
      configured()
      controller = new AbortController()
      task = loop(AbortSignal.any([signal, controller.signal])).finally(() => {
        task = undefined
      })
    },
    async stop() {
      controller?.abort()
      socket?.destroy()
      runtime?.host.connection('disconnected')
      await stopTask(task)
    },
    send
  }
}
