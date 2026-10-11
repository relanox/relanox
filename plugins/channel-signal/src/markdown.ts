import { markdownRuns, splitMarkdown } from '@relanox/markdown'
import type { MarkdownRun } from '@relanox/markdown'

function styles(run: MarkdownRun): readonly string[] {
  if (run.code || run.pre) {
    return ['MONOSPACE']
  }
  return [
    ...(run.bold ? ['BOLD'] : []),
    ...(run.italic ? ['ITALIC'] : []),
    ...(run.strikethrough ? ['STRIKETHROUGH'] : [])
  ]
}

/** Signal-cli's textStyle ranges are UTF-16 start:length:STYLE strings. */
export function signalMarkdown(markdown: string): {
  message: string
  textStyle?: string[]
} {
  let message = ''
  const textStyle: string[] = []
  for (const run of markdownRuns(markdown)) {
    for (const style of styles(run)) {
      textStyle.push(`${message.length}:${run.text.length}:${style}`)
    }
    message += run.text
    if (run.href && run.href !== run.text) {
      message += ` (${run.href})`
    }
  }
  return { message, ...(textStyle.length > 0 ? { textStyle } : {}) }
}

export function splitSignalMarkdown(markdown: string): readonly string[] {
  return splitMarkdown(markdown, {
    maxLength: 16_000,
    unit: 'utf8',
    measure: (part) => Buffer.byteLength(signalMarkdown(part).message, 'utf8')
  })
}
