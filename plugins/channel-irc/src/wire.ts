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
    text = text.slice(separator + 1)
  }
  if (text.startsWith(':')) {
    const separator = text.indexOf(' ')
    if (separator === -1) {
      throw new Error('invalid_prefix')
    }
    prefix = text.slice(1, separator)
    text = text.slice(separator + 1)
  }
  const trailing = text.indexOf(' :')
  const words = (trailing === -1 ? text : text.slice(0, trailing)).split(/ +/u)
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

export function foldNick(value: string): string {
  return value
    .toLowerCase()
    .replaceAll(
      /[[\]\\^]/gu,
      (char) => ({ '[': '{', ']': '}', '\\': '|', '^': '~' })[char] ?? char
    )
}

export function wireLine(text: string): string {
  if (/[\r\n\0]/u.test(text) || Buffer.byteLength(text, 'utf8') + 2 > 512) {
    throw new Error('invalid_outbound_line')
  }
  return `${text}\r\n`
}
