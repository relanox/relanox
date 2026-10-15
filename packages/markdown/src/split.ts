import { decodeHTML } from 'entities'
import { Lexer } from 'marked'
import type { MarkedToken, Token, Tokens } from 'marked'
import { builtInTokens, isInlineToken, isBlockToken } from './runs.js'

export type MarkdownSplitOptions = {
  readonly maxLength: number
  readonly unit: 'utf8' | 'utf16' | 'codepoint'
  /** Measure the final destination representation, including formatting overhead. */
  measure?(this: void, markdown: string): number
}

type Fits = (text: string) => boolean

export function textLength(
  text: string,
  unit: MarkdownSplitOptions['unit']
): number {
  if (unit === 'utf8') {
    return Buffer.byteLength(text)
  }
  return unit === 'utf16'
    ? text.length
    : Array.from(text, (character) => character).length
}

function escaped(text: string): string {
  return text.replaceAll(/[\\&`*_{}[\]()#+.!>~|=-]/gu, String.raw`\$&`)
}

function longestBacktickRun(text: string): number {
  let longest = 0
  for (const match of text.matchAll(/`+/gu)) {
    longest = Math.max(longest, match[0].length)
  }
  return longest
}

function codeSpan(text: string): string {
  const marker = '`'.repeat(longestBacktickRun(text) + 1)
  const pad = /^`|`$|^ .* $/u.test(text) ? ' ' : ''
  return `${marker}${pad}${text}${pad}${marker}`
}

function fence(text: string, language = ''): string {
  const marker = '`'.repeat(Math.max(3, longestBacktickRun(text) + 1))
  const safeLanguage = language.replaceAll(/[\r\n`]/gu, '')
  return `${marker}${safeLanguage}\n${text}\n${marker}`
}

function startsIndented(text: string): boolean {
  return /^(?:[ \t]*\n)*(?: {4}| {0,3}\t)/u.test(text)
}

function startsIndentedAt(
  characters: readonly string[],
  offset: number
): boolean {
  let spaces = 0
  for (let index = offset; index < characters.length; index += 1) {
    const character = characters[index]
    if (character === '\t' || (character === ' ' && ++spaces === 4)) {
      return true
    }
    if (character === '\n') {
      spaces = 0
    } else if (character !== ' ') {
      return false
    }
  }
  return false
}

function paragraphBoundary(
  characters: readonly string[],
  offset: number,
  count: number
): number {
  if (!startsIndentedAt(characters, offset + count)) {
    return count
  }
  let boundary = count
  while (boundary > 0 && /\s/u.test(characters[offset + boundary - 1] ?? '')) {
    boundary -= 1
  }
  return Math.max(0, boundary - 1)
}

/** Bound each search to the next fragment instead of rendering the entire remaining suffix. */
function fittingPrefix(
  characters: readonly string[],
  offset: number,
  render: (part: string) => string,
  fits: Fits
): number {
  const remaining = characters.length - offset

  const accepts = (count: number): boolean =>
    fits(render(characters.slice(offset, offset + count).join('')))

  let count = 0
  let high = 1
  while (accepts(high)) {
    count = high
    if (high === remaining) {
      return count
    }
    high = Math.min(remaining, high * 2)
  }
  let low = count + 1
  high -= 1
  while (low <= high) {
    const middle = Math.floor((low + high) / 2)
    if (accepts(middle)) {
      count = middle
      low = middle + 1
    } else {
      high = middle - 1
    }
  }
  return count
}

/** Search scalar boundaries; formatting is regenerated for every completed fragment. */
function splitCharacters(
  text: string,
  render: (part: string) => string,
  fits: Fits,
  paragraph = false
): string[] {
  if (!text) {
    if (!fits(render(''))) {
      throw new Error('markdown_fragment_exceeds_limit')
    }
    return [render('')]
  }
  const characters = Array.from(text, (character) => character)
  const output: string[] = []
  let offset = 0
  while (offset < characters.length) {
    let count = fittingPrefix(characters, offset, render, fits)
    if (paragraph && count < characters.length - offset) {
      count = paragraphBoundary(characters, offset, count)
    }
    if (count === 0) {
      throw new Error('markdown_fragment_exceeds_limit')
    }
    output.push(render(characters.slice(offset, offset + count).join('')))
    offset += count
  }
  return output
}

function pack(parts: readonly string[], fits: Fits, separator = ''): string[] {
  const result: string[] = []
  let pending = ''
  for (const part of parts) {
    const joined = pending ? `${pending}${separator}${part}` : part
    if (pending && !fits(joined)) {
      result.push(pending)
      pending = part
    } else {
      pending = joined
    }
    if (!fits(pending)) {
      throw new Error('markdown_fragment_exceeds_limit')
    }
  }
  if (pending) {
    result.push(pending)
  }
  return result
}

function inlineParts(
  tokens: readonly Token[],
  fits: Fits,
  depth: number
): string[] {
  if (depth > 64) {
    throw new Error('markdown_nesting_too_deep')
  }
  return pack(
    builtInTokens(tokens).flatMap((token) =>
      inlineToken(token, fits, depth + 1)
    ),
    fits
  )
}

function wrapped(
  tokens: readonly Token[],
  prefix: string,
  suffix: string,
  fits: Fits,
  depth: number
): string[] {
  const render = (text: string): string => {
    if (!['*', '**', '~~'].includes(prefix)) {
      return `${prefix}${text}${suffix}`
    }
    const leading = /^\s*/u.exec(text)?.[0] ?? ''
    const trailing = /\s*$/u.exec(text)?.[0] ?? ''
    const content = text.trim()
    return content ? `${leading}${prefix}${content}${suffix}${trailing}` : text
  }

  return inlineParts(tokens, (text) => fits(render(text)), depth).map(render)
}

function inlineToken(token: MarkedToken, fits: Fits, depth: number): string[] {
  if (!isInlineToken(token)) {
    return splitCharacters(token.raw, escaped, fits)
  }
  switch (token.type) {
    case 'strong': {
      return wrapped(token.tokens, '**', '**', fits, depth)
    }
    case 'em': {
      return wrapped(token.tokens, '*', '*', fits, depth)
    }
    case 'del': {
      return wrapped(token.tokens, '~~', '~~', fits, depth)
    }
    case 'link':
    case 'image': {
      const href = token.href
        .replaceAll('>', '%3E')
        .replaceAll('<', '%3C')
        .replaceAll('\n', '%0A')

      const tokens =
        token.tokens.length > 0
          ? token.tokens
          : Lexer.lexInline(escaped(token.type === 'image' ? 'Image' : href))

      return wrapped(
        tokens,
        token.type === 'image' ? '![' : '[',
        `](<${href}>)`,
        fits,
        depth
      )
    }
    case 'codespan': {
      return splitCharacters(token.text, codeSpan, fits)
    }
    case 'text': {
      return token.tokens
        ? inlineParts(token.tokens, fits, depth)
        : splitCharacters(decodeHTML(token.text), escaped, fits, true)
    }
    case 'escape': {
      return splitCharacters(token.text, escaped, fits, true)
    }
    case 'br': {
      return ['  \n']
    }
    case 'html': {
      return splitCharacters(token.text, escaped, fits, true)
    }
  }
  throw new Error('unsupported_markdown_token')
}

function taskPrefix(item: Tokens.ListItem): string {
  if (!item.task) {
    return ''
  }
  return item.checked ? '[x] ' : '[ ] '
}

function tableAlignment(align: 'left' | 'center' | 'right' | null): string {
  if (align === 'center') {
    return ':---:'
  }
  return align === 'right' ? '---:' : '---'
}

function listParts(token: Tokens.List, fits: Fits, depth: number): string[] {
  const parts: string[] = []
  for (const [index, item] of token.items.entries()) {
    const bullet = token.ordered ? `${Number(token.start) + index}. ` : '- '
    const prefix = `${bullet}${taskPrefix(item)}`
    const indent = ' '.repeat(prefix.length)

    const wrap = (text: string): string =>
      prefix + text.replaceAll('\n', `\n${indent}`)

    const children = blockParts(
      item.tokens,
      (text) => fits(wrap(text)),
      depth + 1
    )

    parts.push(...children.map(wrap))
  }
  return pack(parts, fits, '\n')
}

function tableParts(token: Tokens.Table, fits: Fits, depth: number): string[] {
  const cell = (value: Tokens.TableCell): string =>
    inlineParts(value.tokens, () => true, depth + 1)
      .join('')
      .replaceAll(/(?<!\\)\|/gu, String.raw`\|`)

  const row = (values: readonly Tokens.TableCell[]): string =>
    `| ${values.map(cell).join(' | ')} |`

  const header = `${row(token.header)}\n| ${token.align.map(tableAlignment).join(' | ')} |`
  if (!fits(header)) {
    throw new Error('markdown_table_header_exceeds_limit')
  }
  const chunks: string[] = []
  let pending = header
  for (const values of token.rows) {
    const line = row(values)
    if (!fits(`${header}\n${line}`)) {
      throw new Error('markdown_table_row_exceeds_limit')
    }
    if (!fits(`${pending}\n${line}`)) {
      chunks.push(pending)
      pending = header
    }
    pending += `\n${line}`
  }
  chunks.push(pending)
  return chunks
}

function blockToken(token: MarkedToken, fits: Fits, depth: number): string[] {
  if (!isBlockToken(token)) {
    return inlineToken(token, fits, depth)
  }
  switch (token.type) {
    case 'paragraph':
    case 'text': {
      const paragraphs = inlineParts(
        token.tokens ?? Lexer.lexInline(token.text),
        fits,
        depth
      )

      if (paragraphs.some(startsIndented)) {
        throw new Error('markdown_fragment_exceeds_limit')
      }
      return paragraphs
    }
    case 'heading': {
      const prefix = `${'#'.repeat(token.depth)} `
      return inlineParts(
        token.tokens,
        (text) => fits(prefix + text),
        depth
      ).map((text) => prefix + text)
    }
    case 'code': {
      return splitCharacters(
        token.text,
        (text) => fence(text, token.lang),
        fits
      )
    }
    case 'blockquote': {
      return blockParts(
        token.tokens,
        (text) => fits(`> ${text.replaceAll('\n', '\n> ')}`),
        depth
      ).map((text) => `> ${text.replaceAll('\n', '\n> ')}`)
    }
    case 'list': {
      return listParts(token, fits, depth)
    }
    case 'table': {
      return tableParts(token, fits, depth)
    }
    case 'space':
    case 'def': {
      return []
    }
    case 'hr': {
      return ['---']
    }
    case 'html': {
      return inlineToken(token, fits, depth)
    }
  }
  throw new Error('unsupported_markdown_token')
}

function blockParts(tokens: readonly Token[], fits: Fits, depth = 0): string[] {
  if (depth > 64) {
    throw new Error('markdown_nesting_too_deep')
  }
  return pack(
    builtInTokens(tokens).flatMap((token) =>
      blockToken(token, fits, depth + 1)
    ),
    fits,
    '\n\n'
  )
}

/** Keep short Markdown untouched; reserialize long blocks with closed formatting and resolved links. */
export function splitMarkdown(
  markdown: string,
  options: MarkdownSplitOptions
): readonly string[] {
  if (!Number.isSafeInteger(options.maxLength) || options.maxLength < 1) {
    throw new Error('invalid_markdown_limit')
  }
  if (!markdown.isWellFormed()) {
    throw new Error('malformed_markdown_unicode')
  }

  const measure =
    options.measure ??
    ((text: string): number => textLength(text, options.unit))

  const fits = (text: string): boolean => measure(text) <= options.maxLength
  if (fits(markdown)) {
    return [markdown]
  }
  return blockParts(Lexer.lex(markdown, { gfm: true }), fits)
}
