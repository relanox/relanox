import { decodeHTML } from 'entities'
import { Lexer } from 'marked'
import type { MarkedToken, Token } from 'marked'
import { builtInTokens } from './runs.js'

export type RichMarkdownPart =
  | { readonly type: 'text'; readonly text: string }
  | {
      readonly type: 'media'
      readonly reference:
        | { readonly kind: 'media'; readonly id: string }
        | { readonly kind: 'attachment'; readonly index: number }
      readonly label: string
      readonly image: boolean
    }

function reference(
  href: string
): Extract<RichMarkdownPart, { type: 'media' }>['reference'] | undefined {
  const value = decodeHTML(href)
  if (!/^relanox:/iu.test(value)) {
    return undefined
  }

  const media =
    /^relanox:\/\/media\/(?<id>[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/u.exec(
      value
    )

  if (media) {
    return { kind: 'media', id: media.groups?.id ?? '' }
  }

  const attachment = /^relanox:\/\/attachment\/(?<index>[1-9][0-9]*)$/u.exec(
    value
  )

  const index = Number(attachment?.groups?.index)
  if (attachment && Number.isSafeInteger(index)) {
    return { kind: 'attachment', index }
  }
  throw new Error('invalid_media_reference')
}

function text(value: string): RichMarkdownPart {
  return { type: 'text', text: value }
}

function merge(parts: readonly RichMarkdownPart[]): RichMarkdownPart[] {
  const result: RichMarkdownPart[] = []
  for (const part of parts) {
    const previous = result.at(-1)
    if (part.type === 'text' && previous?.type === 'text') {
      result[result.length - 1] = text(previous.text + part.text)
    } else if (part.type !== 'text' || part.text) {
      result.push(part)
    }
  }
  return result
}

function wrap(
  parts: readonly RichMarkdownPart[],
  prefix: string,
  suffix: string
): RichMarkdownPart[] {
  return parts.map((part) => {
    if (part.type !== 'text' || !part.text.trim()) {
      return part
    }
    const leading = /^\s*/u.exec(part.text)?.[0] ?? ''
    const trailing = /\s*$/u.exec(part.text)?.[0] ?? ''
    return text(`${leading}${prefix}${part.text.trim()}${suffix}${trailing}`)
  })
}

function children(tokens: readonly Token[], depth: number): RichMarkdownPart[] {
  if (depth > 64) {
    throw new Error('markdown_nesting_too_deep')
  }
  return merge(
    builtInTokens(tokens).flatMap((token) => parseToken(token, depth + 1))
  )
}

function taskPrefix(
  task: boolean | undefined,
  checked: boolean | undefined
): string {
  if (!task) {
    return ''
  }
  return checked ? '[x] ' : '[ ] '
}

type ContainerToken = Extract<
  MarkedToken,
  {
    type:
      | 'strong'
      | 'em'
      | 'del'
      | 'paragraph'
      | 'heading'
      | 'text'
      | 'blockquote'
      | 'list'
      | 'table'
      | 'link'
      | 'image'
  }
>

function isContainer(token: MarkedToken): token is ContainerToken {
  return [
    'strong',
    'em',
    'del',
    'paragraph',
    'heading',
    'text',
    'blockquote',
    'list',
    'table',
    'link',
    'image'
  ].includes(token.type)
}

function labelText(tokens: readonly Token[], depth = 0): string {
  if (depth > 64) {
    throw new Error('markdown_nesting_too_deep')
  }
  return builtInTokens(tokens)
    .map((token) => {
      if ('tokens' in token && token.tokens !== undefined) {
        return labelText(token.tokens, depth + 1)
      }
      if (token.type === 'br') {
        return '\n'
      }
      if (token.type === 'codespan' || token.type === 'escape') {
        return token.text
      }
      return decodeHTML('text' in token ? token.text : token.raw)
    })
    .join('')
}

function linkParts(
  token: Extract<MarkedToken, { type: 'link' | 'image' }>,
  depth: number
): RichMarkdownPart[] {
  const found = reference(token.href)
  if (found) {
    return [
      {
        type: 'media',
        reference: found,
        label: labelText(token.tokens),
        image: token.type === 'image'
      }
    ]
  }

  const parts =
    token.type === 'image' ? [text(token.text)] : children(token.tokens, depth)

  const prefix = token.type === 'image' ? '![' : '['

  const href = token.href
    .replaceAll('<', '%3C')
    .replaceAll('>', '%3E')
    .replaceAll('\n', '%0A')

  const title = token.title ? ` "${token.title.replaceAll('"', '&quot;')}"` : ''

  const suffix = `](<${href}>${title})`
  return (parts.length > 0 ? parts : [text('')]).map((part) =>
    part.type === 'text' ? text(prefix + part.text + suffix) : part
  )
}

function parseToken(token: MarkedToken, depth: number): RichMarkdownPart[] {
  if (!isContainer(token)) {
    return [text(token.raw)]
  }
  switch (token.type) {
    case 'link':
    case 'image': {
      return linkParts(token, depth)
    }
    case 'strong': {
      const marker = token.raw.startsWith('__') ? '__' : '**'
      return wrap(children(token.tokens, depth), marker, marker)
    }
    case 'em': {
      const marker = token.raw.startsWith('_') ? '_' : '*'
      return wrap(children(token.tokens, depth), marker, marker)
    }
    case 'del': {
      return wrap(children(token.tokens, depth), '~~', '~~')
    }
    case 'paragraph':
    case 'heading':
    case 'text': {
      if (!token.tokens) {
        return [text(token.raw)]
      }
      const parts = children(token.tokens, depth)

      const content =
        token.type === 'heading'
          ? wrap(parts, `${'#'.repeat(token.depth)} `, '')
          : parts

      return [...content, text(/\n*$/u.exec(token.raw)?.[0] ?? '')]
    }
    case 'blockquote': {
      return children(token.tokens, depth).map((part) =>
        part.type === 'text'
          ? text(`> ${part.text.replaceAll('\n', '\n> ')}`)
          : part
      )
    }
    case 'list': {
      return merge(
        token.items.flatMap((item, index) => {
          const bullet = token.ordered
            ? `${Number(token.start) + index}. `
            : '- '

          const prefix = bullet + taskPrefix(item.task, item.checked)

          return [
            ...children(item.tokens, depth).map((part) =>
              part.type === 'text'
                ? text(
                    prefix +
                      part.text.replaceAll(
                        '\n',
                        `\n${' '.repeat(prefix.length)}`
                      )
                  )
                : part
            ),
            text('\n')
          ]
        })
      )
    }
    case 'table': {
      return merge(
        [token.header, ...token.rows].flatMap((row) =>
          row.flatMap((cell, index) => [
            ...(index ? [text(' | ')] : []),
            ...children(cell.tokens, depth),
            ...(index === row.length - 1 ? [text('\n')] : [])
          ])
        )
      )
    }
  }
  throw new Error('unsupported_markdown_token')
}

/**
 * Extract native media references in reading order. Attachment indices are one based.
 * Ordinary Markdown is returned byte for byte. With media, inline styles are closed
 * around each text fragment, lists and quotes are rebuilt, and tables become rows
 * of cells separated by pipes. HTML and code are opaque; generated text is never parsed.
 */
export function parseRichMarkdown(
  markdown: string
): readonly RichMarkdownPart[] {
  if (!markdown.isWellFormed()) {
    throw new Error('malformed_markdown_unicode')
  }
  const parts = children(Lexer.lex(markdown, { gfm: true }), 0)
  return parts.some((part) => part.type === 'media') ? parts : [text(markdown)]
}
