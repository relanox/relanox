import { createServer } from 'node:net'
import type { Socket } from 'node:net'
import type { SendInput } from '@relanox/sdk'
import { expect, it } from 'vitest'
import {
  cleanup,
  harness,
  httpPeer,
  json,
  observations,
  waitFor
} from '../../channel-matrix/tests/harness.js'
import { createIrcChannel } from '../src/index.js'

async function tcpPeer(
  onLine: (line: string, socket: Socket) => void
): Promise<{ port: number; lines: string[]; sockets: Socket[] }> {
  const lines: string[] = []
  const sockets: Socket[] = []

  const server = createServer((socket) => {
    sockets.push(socket)
    // A peer reset is expected when the reconnect and shutdown cases close a live connection.
    socket.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code !== 'ECONNRESET') {
        throw error
      }
    })
    socket.setEncoding('utf8')
    let buffer = ''
    socket.on('data', (data: string) => {
      buffer += data
      const sendReply = buffer.split('\r\n')
      buffer = sendReply.pop() ?? ''
      for (const line of sendReply) {
        lines.push(line)
        onLine(line, socket)
      }
    })
  })

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') {
    throw new Error('Missing TCP address')
  }
  cleanup(async () => {
    for (const socket of sockets) {
      socket.destroy()
    }
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error)
        } else {
          resolve()
        }
      })
    })
  })
  return { port: address.port, lines, sockets }
}

function config(port: number): {
  server: string
  port: number
  tls: boolean
  allowInsecureLocalhost: boolean
  nick: string
  sasl: { username: string; password: { env: string } }
} {
  return {
    server: '127.0.0.1',
    port,
    tls: false,
    allowInsecureLocalhost: true,
    nick: 'relay',
    sasl: { username: 'relay', password: { env: 'IRC_SASL' } }
  }
}

function register(line: string, socket: Socket): void {
  if (line === 'CAP LS 302') {
    socket.write(
      ':server CAP relay LS * :account-tag server-time\r\n:server CAP relay LS :message-tags sasl=PLAIN\r\n'
    )
  }
  if (line.startsWith('CAP REQ :')) {
    socket.write(`:server CAP relay ACK :${line.slice(9)}\r\n`)
  }
  if (line === 'AUTHENTICATE PLAIN') {
    socket.write('AUTHENTICATE +\r\n')
  }
  if (line.startsWith('AUTHENTICATE ') && line !== 'AUTHENTICATE PLAIN') {
    socket.write(':server 903 relay :SASL successful\r\n')
  }
  if (line === 'CAP END') {
    socket.write(':server 001 relay :Welcome\r\n')
  }
}

function sendInput(
  port: number,
  recipient = '#room',
  text = 'answer'
): SendInput {
  return {
    deliveryId: 'delivery',
    channelId: 'request',
    target: {
      channel: 'irc',
      accountId: 'bot',
      chatId:
        recipient.startsWith('#') || recipient.startsWith('&')
          ? recipient
          : `dm:${recipient}`,
      data: { recipient, server: '127.0.0.1', port, tls: false }
    },
    chunk: { text, idempotencyKey: 'delivery:0', state: null },
    chunkIndex: 0,
    signal: new AbortController().signal
  }
}

it('renders Markdown using IRC controls and budgets styled UTF-8 text with the actual target', async () => {
  const tcp = await tcpPeer(register)

  const http = await httpPeer((_request, response) => {
    json(response, {})
  })

  const plugin = createIrcChannel({ IRC_SASL: 'password' })
  await harness(
    plugin,
    config(tcp.port),
    [{ chatId: '#room' }],
    ['account:alice'],
    `${http.base}/dispatch`
  )
  await plugin.start?.(new AbortController().signal)
  await waitFor(() => tcp.lines.includes('JOIN #room'))
  expect(
    (
      await plugin.send(
        sendInput(
          tcp.port,
          '#room',
          '😀 **bold** _ital_ ~~gone~~ `x*y` [site](https://example.com)'
        )
      )
    ).status
  ).toBe('sent')
  await waitFor(() => tcp.lines.some((line) => line.startsWith('PRIVMSG ')))
  expect(tcp.lines.find((line) => line.startsWith('PRIVMSG '))).toBe(
    'PRIVMSG #room :😀 \u0002bold\u000F \u001Dital\u000F \u001Egone\u000F \u0011x*y\u000F site (https://example.com/)'
  )
  const recipient = `#${'x'.repeat(89)}`
  const input = sendInput(tcp.port, recipient)

  const parts =
    plugin.splitText?.(`**${'界😀'.repeat(100)}**`, input.target) ?? []

  expect(parts.length).toBeGreaterThan(1)
  for (const [index, text] of parts.entries()) {
    expect(
      (
        await plugin.send({
          ...input,
          chunkIndex: index,
          chunk: { ...input.chunk, text }
        })
      ).status
    ).toBe('sent')
  }
  await waitFor(
    () =>
      tcp.lines.filter((line) => line.startsWith(`PRIVMSG ${recipient} :`))
        .length === parts.length
  )

  const sent = tcp.lines.filter((line) =>
    line.startsWith(`PRIVMSG ${recipient} :`)
  )

  const texts: string[] = []
  for (const line of sent) {
    expect(Buffer.byteLength(`${line}\r\n`, 'utf8')).toBeLessThanOrEqual(512)
    const text = line.slice(`PRIVMSG ${recipient} :`.length)
    expect(text.startsWith('\u0002') && text.endsWith('\u000F')).toBe(true)
    texts.push(text.replaceAll('\u0002', '').replaceAll('\u000F', ''))
  }
  expect(texts.join('')).toBe('界😀'.repeat(100))
  await plugin.stop?.()
})

it('negotiates SASL and tags, ingests channel/private text and independently writes delayed replies', async () => {
  const tcp = await tcpPeer((line, socket) => {
    register(line, socket)
    if (line === 'JOIN #room') {
      socket.write('PING :server-ping\r\n')
      socket.write(
        '@account=alice;msgid=room-message;time=2027-01-15T08:00:00.000Z :Alice!u@h PRIVMSG #room :channel question\r\n'
      )
      socket.write(
        '@account=alice;msgid=room-message;time=2027-01-15T08:00:00.000Z :Alice!u@h PRIVMSG #room :channel question\r\n'
      )
      socket.write(':relay!u@h NICK :relay2\r\n')
      socket.write(
        '@account=alice;msgid=private-message;time=2027-01-15T08:00:01.000Z :Alice!u@h PRIVMSG relay2 :private question\r\n'
      )
      socket.write(
        '@account=bot;msgid=self-message :relay2!u@h PRIVMSG #room :echo\r\n'
      )
      socket.write(
        '@account=mallory;msgid=blocked :Mallory!u@h PRIVMSG #room :forbidden\r\n'
      )
      socket.write(':Alice!u@h PRIVMSG #room :missing account\r\n')
    }
  })

  const http = await httpPeer((_request, response) => {
    json(response, {})
  })

  const observation = observations()
  const plugin = createIrcChannel({ IRC_SASL: 'sasl-password' })

  const fixture = await harness(
    plugin,
    config(tcp.port),
    [{ chatId: '#room' }, { chatId: 'dm:alice' }],
    ['account:alice'],
    `${http.base}/dispatch`,
    { observe: observation.observe }
  )

  await plugin.start?.(new AbortController().signal)
  await waitFor(
    async () =>
      (await fixture.storage.listInbound({ limit: 10 })).length === 2 &&
      tcp.lines.includes('PONG :server-ping')
  )
  const requests = await fixture.storage.listInbound({ limit: 10 })
  expect(tcp.lines).toContain(
    'CAP REQ :account-tag server-time message-tags sasl'
  )
  expect(tcp.lines).toContain('NICK relay')
  expect(tcp.lines).toContain('USER relay 0 * :Relanox')
  expect(tcp.lines.filter((line) => line.startsWith('JOIN '))).toEqual([
    'JOIN #room'
  ])

  const sasl = tcp.lines.find(
    (line) => line.startsWith('AUTHENTICATE ') && line !== 'AUTHENTICATE PLAIN'
  )

  if (!sasl) {
    throw new Error('Missing SASL response')
  }
  expect(Buffer.from(sasl.slice(13), 'base64').toString('utf8')).toBe(
    '\0relay\0sasl-password'
  )
  expect(requests.map((request) => request.snapshot.senderId)).toEqual([
    'account:alice',
    'account:alice'
  ])

  const channel = requests.find(
    (request) => request.snapshot.text === 'channel question'
  )

  const direct = requests.find(
    (request) => request.snapshot.text === 'private question'
  )

  if (!channel || !direct) {
    throw new Error('Missing channel/private input')
  }
  expect(channel.snapshot.target).toEqual({
    channel: 'irc',
    accountId: 'bot',
    chatId: '#room',
    replyToId: 'room-message',
    data: {
      recipient: '#room',
      server: '127.0.0.1',
      port: tcp.port,
      tls: false
    }
  })
  expect(direct.snapshot.target).toEqual({
    channel: 'irc',
    accountId: 'bot',
    chatId: 'dm:alice',
    replyToId: 'private-message',
    data: {
      recipient: 'Alice',
      server: '127.0.0.1',
      port: tcp.port,
      tls: false
    }
  })
  expect(channel.snapshot.receivedAt).toBe(1_800_000_000_000)
  expect(
    observation.logs.some(
      (entry) => entry.fields?.errorCode === 'account_identity_required'
    )
  ).toBe(true)
  expect(JSON.stringify(requests)).not.toContain('sasl-password')
  await fixture.runtime.processDue()
  for (const request of await fixture.storage.listInbound({ limit: 10 })) {
    const result = await fixture.sendReply(
      request.snapshot.requestId,
      'delayed\nanswer\rwith\r\nlines'
    )

    await fixture.runtime.processDue()
    expect(
      (await fixture.storage.getOutbound(result.deliveryId))?.receipts
    ).toEqual([{ data: { acknowledgement: 'socket_write' } }])
  }
  await waitFor(
    () => tcp.lines.filter((line) => line.startsWith('PRIVMSG ')).length === 2
  )
  expect(tcp.lines.filter((line) => line.startsWith('PRIVMSG '))).toEqual(
    expect.arrayContaining([
      'PRIVMSG #room :delayed answer with lines',
      'PRIVMSG alice :delayed answer with lines'
    ])
  )
  await plugin.stop?.()
  expect((await fixture.runtime.status()).connections['channels/bot']).toBe(
    'disconnected'
  )
  expect(plugin.capabilities.idempotentSend).toBe(false)
})

it('reconnects and relies on durable msgid dedup while retaining configured account identity', async () => {
  const tcp = await tcpPeer((line, socket) => {
    register(line, socket)
    if (line === 'JOIN #room') {
      socket.write(
        '@account=alice;msgid=stable :Alice!u@h PRIVMSG #room :same event\r\n'
      )
    }
  })

  const http = await httpPeer((_request, response) => {
    json(response, {})
  })

  const plugin = createIrcChannel({ IRC_SASL: 'password' })

  const fixture = await harness(
    plugin,
    config(tcp.port),
    [{ chatId: '#room' }],
    ['account:alice'],
    `${http.base}/dispatch`
  )

  await plugin.start?.(new AbortController().signal)
  await waitFor(
    async () => (await fixture.storage.listInbound({ limit: 10 })).length === 1
  )
  tcp.sockets[0]?.destroy()
  await waitFor(
    () => tcp.lines.filter((line) => line === 'JOIN #room').length >= 2
  )
  await plugin.stop?.()
  expect(await fixture.storage.listInbound({ limit: 10 })).toHaveLength(1)
})

it('enforces UTF-8 wire size, renders CRLF as message text and rejects NUL before writing', async () => {
  const tcp = await tcpPeer(register)

  const http = await httpPeer((_request, response) => {
    json(response, {})
  })

  const plugin = createIrcChannel({ IRC_SASL: 'password' })

  const fixture = await harness(
    plugin,
    config(tcp.port),
    [{ chatId: '#room' }],
    ['account:alice'],
    `${http.base}/dispatch`
  )

  await plugin.start?.(new AbortController().signal)
  await waitFor(
    async () =>
      (await fixture.runtime.status()).connections['channels/bot'] ===
      'connected'
  )
  const largeTarget = `#${'x'.repeat(89)}`
  expect(
    (await plugin.send(sendInput(tcp.port, largeTarget, '😀'.repeat(100))))
      .status
  ).toBe('sent')
  expect(
    await plugin.send(sendInput(tcp.port, largeTarget, '😀'.repeat(103)))
  ).toEqual({
    status: 'rejected',
    errorCode: 'invalid_irc_text'
  })
  expect(
    await plugin.send(sendInput(tcp.port, '#room', 'answer\r\nJOIN #evil'))
  ).toEqual({
    status: 'sent',
    receipt: { data: { acknowledgement: 'socket_write' } }
  })
  expect(
    await plugin.send(sendInput(tcp.port, '#room', 'answer\0hidden'))
  ).toEqual({
    status: 'rejected',
    errorCode: 'invalid_irc_text'
  })
  await waitFor(() => tcp.lines.includes('PRIVMSG #room :answer JOIN #evil'))
  const outgoing = tcp.lines.filter((line) => line.startsWith('PRIVMSG '))
  expect(outgoing).toHaveLength(2)
  expect(Buffer.byteLength(`${outgoing[0]}\r\n`)).toBe(502)
  expect(tcp.lines).not.toContain('JOIN #evil')
  await plugin.stop?.()
  expect((await plugin.send(sendInput(tcp.port))).status).toBe('retryable')
})

it('requires SASL when configured and never joins after authentication failure', async () => {
  const observation = observations()

  const tcp = await tcpPeer((line, socket) => {
    if (line === 'CAP LS 302') {
      socket.write(':server CAP relay LS :account-tag\r\n')
    }
  })

  const http = await httpPeer((_request, response) => {
    json(response, {})
  })

  const plugin = createIrcChannel({ IRC_SASL: 'password' })

  const fixture = await harness(
    plugin,
    config(tcp.port),
    [{ chatId: '#room' }],
    ['account:alice'],
    `${http.base}/dispatch`,
    { observe: observation.observe }
  )

  await plugin.start?.(new AbortController().signal)
  await waitFor(() =>
    observation.logs.some(
      (entry) => entry.fields?.errorCode === 'receive_failed'
    )
  )
  await plugin.stop?.()
  expect(tcp.lines).not.toContain('JOIN #room')
  expect(await fixture.storage.listInbound({ limit: 10 })).toEqual([])
})

it('allows explicit nickname fallback with a diagnostic and keeps secure defaults', async () => {
  const observation = observations()

  const tcp = await tcpPeer((line, socket) => {
    register(line, socket)
    if (line === 'JOIN #room') {
      socket.write(':Alice!u@h PRIVMSG #room :legacy server\r\n')
    }
  })

  const http = await httpPeer((_request, response) => {
    json(response, {})
  })

  const plugin = createIrcChannel({ IRC_SASL: 'password' })

  const fixture = await harness(
    plugin,
    { ...config(tcp.port), allowNickFallback: true },
    [{ chatId: '#room' }],
    ['nick:alice'],
    `${http.base}/dispatch`,
    { observe: observation.observe }
  )

  await plugin.start?.(new AbortController().signal)
  await waitFor(
    async () => (await fixture.storage.listInbound({ limit: 10 })).length === 1
  )
  await plugin.stop?.()
  expect(
    (await fixture.storage.listInbound({ limit: 10 }))[0]?.snapshot.senderId
  ).toBe('nick:alice')
  expect(
    observation.logs.some(
      (entry) => entry.fields?.errorCode === 'nick_identity_fallback'
    )
  ).toBe(true)
  expect(
    plugin.validateConfig({ server: 'irc.example', nick: 'relay' }).tls
  ).toBe(true)
  expect(() =>
    plugin.validateConfig({ ...config(tcp.port), server: 'irc.example' })
  ).toThrow('tls_required')
  expect(() =>
    plugin.validateConfig({ ...config(tcp.port), nick: 'relay\r\nJOIN #evil' })
  ).toThrow()
  expect(() =>
    plugin.validateConfig({ ...config(tcp.port), channels: ['#room'] })
  ).toThrow()
})
