export type IrcMessage = {
  readonly tags: Readonly<Record<string, string>>
  readonly prefix?: string
  readonly command: string
  readonly params: readonly string[]
}

function unescapeTag(value: string): string {
  return value.replaceAll(
    /\\(?<character>.)/gu,
    (_, char: string) =>
      ({ ':': ';', s: ' ', r: '\r', n: '\n', '\\': '\\' })[char] ?? char
  )
}

export function parseMessage(line: string): IrcMessage {
  if (/[\r\n\0]/u.test(line)) {
    throw new Error('invalid_irc_line')
  }
  let text = line
  const tags: Record<string, string> = {}
  let prefix: string | undefined
  if (text.startsWith('@')) {
    const separator = text.indexOf(' ')
    if (separator === -1) {
      throw new Error('invalid_tags')
    }
    for (const tag of text.slice(1, separator).split(';')) {
      const equals = tag.indexOf('=')
      tags[equals === -1 ? tag : tag.slice(0, equals)] =
        equals === -1 ? '' : unescapeTag(tag.slice(equals + 1))
    }
    text = text.slice(separator + 1).replace(/^ +/u, '')
  }
  if (text.startsWith(':')) {
    const separator = text.indexOf(' ')
    if (separator === -1) {
      throw new Error('invalid_prefix')
    }
    prefix = text.slice(1, separator)
    text = text.slice(separator + 1).replace(/^ +/u, '')
  }
  const trailing = text.indexOf(' :')

  const words = (trailing === -1 ? text : text.slice(0, trailing))
    .replace(/ +$/u, '')
    .split(/ +/u)

  const command = words.shift()
  if (!command) {
    throw new Error('missing_command')
  }
  if (trailing !== -1) {
    words.push(text.slice(trailing + 2))
  }
  return {
    tags,
    ...(prefix ? { prefix } : {}),
    command: command.toUpperCase(),
    params: words
  }
}

export type CaseMapping = 'ascii' | 'rfc1459' | 'strict-rfc1459'

export function foldNick(
  value: string,
  mapping: CaseMapping = 'rfc1459'
): string {
  const lower = value.replaceAll(/[A-Z]/gu, (char) => char.toLowerCase())
  if (mapping === 'ascii') {
    return lower
  }
  return lower.replaceAll(
    /[[\]\\^]/gu,
    (char) =>
      ({
        '[': '{',
        ']': '}',
        '\\': '|',
        '^': mapping === 'rfc1459' ? '~' : '^'
      })[char] ?? char
  )
}

export function wireLine(text: string): string {
  let message = text
  if (text.startsWith('@')) {
    const separator = text.indexOf(' ')
    // IRCv3 client tags have a separate 4094-byte data budget; the command
    // And CRLF retain their original 512-byte limit.
    if (
      separator === -1 ||
      Buffer.byteLength(text.slice(0, separator + 1), 'utf8') > 4096
    ) {
      throw new Error('invalid_outbound_tags')
    }
    message = text.slice(separator + 1)
  }
  if (/[\r\n\0]/u.test(text) || Buffer.byteLength(message, 'utf8') + 2 > 512) {
    throw new Error('invalid_outbound_line')
  }
  return `${text}\r\n`
}

export function escapeTag(value: string): string {
  return value.replaceAll(
    /[; \\\r\n]/gu,
    (character) =>
      ({
        ';': String.raw`\:`,
        ' ': String.raw`\s`,
        '\\': String.raw`\\`,
        '\r': String.raw`\r`,
        '\n': String.raw`\n`
      })[character] ?? character
  )
}
