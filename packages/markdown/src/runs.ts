import { decodeHTML } from 'entities'
import { Lexer } from 'marked'
import type { MarkedToken, Token, Tokens } from 'marked'

/** Visible text and semantic inline styles, independent of any destination's syntax. */
export type MarkdownRun = {
  readonly text: string
  readonly bold?: boolean
  readonly italic?: boolean
  readonly strikethrough?: boolean
  readonly code?: boolean
  readonly pre?: boolean
  readonly language?: string
  readonly href?: string
}

type Style = Omit<MarkdownRun, 'text'>

export function safeLink(value: string): string | undefined {
  try {
    const url = new URL(decodeHTML(value))
    if (
      !['https:', 'http:', 'mailto:'].includes(url.protocol) ||
      url.username ||
      url.password
    ) {
      return undefined
    }
    return url.href
  } catch {
    return undefined
  }
}

/** This lexer has no extensions, so it only emits Marked's built-in token union. */
export function builtInTokens(
  tokens: readonly Token[]
): readonly MarkedToken[] {
  return tokens as readonly MarkedToken[]
}

type InlineToken = Extract<
  MarkedToken,
  {
    type:
      | 'strong'
      | 'em'
      | 'del'
      | 'link'
      | 'image'
      | 'codespan'
      | 'br'
      | 'html'
      | 'text'
      | 'escape'
  }
>

type BlockToken = Extract<
  MarkedToken,
  {
    type:
      | 'paragraph'
      | 'text'
      | 'heading'
      | 'code'
      | 'list'
      | 'blockquote'
      | 'table'
      | 'hr'
      | 'html'
      | 'space'
      | 'def'
  }
>

export function isInlineToken(token: MarkedToken): token is InlineToken {
  return new Set([
    'strong',
    'em',
    'del',
    'link',
    'image',
    'codespan',
    'br',
    'html',
    'text',
    'escape'
  ]).has(token.type)
}

export function isBlockToken(token: MarkedToken): token is BlockToken {
  return new Set([
    'paragraph',
    'text',
    'heading',
    'code',
    'list',
    'blockquote',
    'table',
    'hr',
    'html',
    'space',
    'def'
  ]).has(token.type)
}

function taskPrefix(item: Tokens.ListItem): string {
  if (!item.task) {
    return ''
  }
  return item.checked ? '[x] ' : '[ ] '
}

class RunBuilder {
  readonly runs: MarkdownRun[] = []

  add(text: string, style: Style = {}): void {
    if (!text) {
      return
    }
    const previous = this.runs.at(-1)
    const { text: unused, ...previousStyle } = previous ?? { text: '' }
    void unused
    if (previous && JSON.stringify(previousStyle) === JSON.stringify(style)) {
      this.runs[this.runs.length - 1] = { ...style, text: previous.text + text }
    } else {
      this.runs.push({ ...style, text })
    }
  }

  inline(tokens: readonly Token[], style: Style = {}, depth = 0): void {
    if (depth > 64) {
      throw new Error('markdown_nesting_too_deep')
    }
    for (const token of builtInTokens(tokens)) {
      this.inlineToken(token, style, depth)
    }
  }

  private inlineToken(token: MarkedToken, style: Style, depth: number): void {
    if (!isInlineToken(token)) {
      this.add(token.raw, style)
      return
    }
    switch (token.type) {
      case 'strong': {
        this.inline(token.tokens, { ...style, bold: true }, depth + 1)
        break
      }
      case 'em': {
        this.inline(token.tokens, { ...style, italic: true }, depth + 1)
        break
      }
      case 'del': {
        this.inline(token.tokens, { ...style, strikethrough: true }, depth + 1)
        break
      }
      case 'link':
      case 'image': {
        const href = safeLink(token.href)
        const linkStyle = { ...style, ...(href ? { href } : {}) }
        if (token.tokens.length === 0) {
          this.add(token.type === 'image' ? 'Image' : (href ?? ''), linkStyle)
        } else {
          this.inline(token.tokens, linkStyle, depth + 1)
        }
        break
      }
      case 'codespan': {
        this.add(token.text, { code: true })
        break
      }
      case 'br': {
        this.add('\n')
        break
      }
      case 'html': {
        this.add(token.text, style)
        break
      }
      case 'text': {
        if (token.tokens) {
          this.inline(token.tokens, style, depth + 1)
        } else {
          this.add(decodeHTML(token.text), style)
        }
        break
      }
      case 'escape': {
        this.add(token.text, style)
        break
      }
    }
  }

  blocks(tokens: readonly Token[], depth = 0): void {
    if (depth > 64) {
      throw new Error('markdown_nesting_too_deep')
    }
    for (const token of builtInTokens(tokens)) {
      this.block(token, depth)
    }
  }

  private block(token: MarkedToken, depth: number): void {
    if (!isBlockToken(token)) {
      this.inlineToken(token, {}, depth + 1)
      return
    }
    switch (token.type) {
      case 'paragraph':
      case 'text': {
        this.inline(token.tokens ?? Lexer.lexInline(token.text), {}, depth + 1)
        this.add('\n\n')
        break
      }
      case 'heading': {
        this.inline(token.tokens, { bold: true }, depth + 1)
        this.add('\n\n')
        break
      }
      case 'code': {
        this.add(token.text, {
          pre: true,
          ...(token.lang ? { language: token.lang.split(/\s/u)[0] ?? '' } : {})
        })
        this.add('\n\n')
        break
      }
      case 'list': {
        this.list(token, depth + 1)
        break
      }
      case 'blockquote': {
        this.add('> ')
        this.blocks(token.tokens, depth + 1)
        break
      }
      case 'table': {
        this.table(token, depth + 1)
        break
      }
      case 'hr': {
        this.add('────────\n\n')
        break
      }
      case 'html': {
        this.add(`${token.text}\n\n`)
        break
      }
      case 'space':
      case 'def': {
        break
      }
    }
  }

  private list(token: Tokens.List, depth: number): void {
    for (const [index, item] of token.items.entries()) {
      const prefix = token.ordered ? `${Number(token.start) + index}. ` : '• '
      this.add(`${prefix}${taskPrefix(item)}`)
      this.blocks(item.tokens, depth + 1)
    }
  }

  private table(token: Tokens.Table, depth: number): void {
    for (const [rowIndex, row] of [token.header, ...token.rows].entries()) {
      for (const [cellIndex, cell] of row.entries()) {
        if (cellIndex > 0) {
          this.add(' | ')
        }
        this.inline(
          cell.tokens,
          rowIndex === 0 ? { bold: true } : {},
          depth + 1
        )
      }
      this.add('\n')
    }
    this.add('\n')
  }
}

export function markdownRuns(markdown: string): readonly MarkdownRun[] {
  if (!markdown.isWellFormed()) {
    throw new Error('malformed_markdown_unicode')
  }
  const builder = new RunBuilder()
  builder.blocks(Lexer.lex(markdown, { gfm: true }))
  // Block separators belong between content, never after the last visible character.
  const last = builder.runs.at(-1)
  if (last) {
    builder.runs[builder.runs.length - 1] = {
      ...last,
      text: last.text.replace(/\n+$/u, '')
    }
  }
  return builder.runs.filter((run) => run.text.length > 0)
}

export function markdownText(markdown: string): string {
  return markdownRuns(markdown)
    .map((run) => run.text)
    .join('')
}
