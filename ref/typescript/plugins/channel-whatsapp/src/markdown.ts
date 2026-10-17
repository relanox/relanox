import { markdownRuns, splitMarkdown } from '@relanox/markdown'
import type { MarkdownRun } from '@relanox/markdown'

function formatted(run: MarkdownRun): string {
  // WhatsApp has no variable-length code delimiter or link-label syntax.
  if (run.pre || run.code) {
    return run.text.includes('```') ? run.text : `\`\`\`${run.text}\`\`\``
  }
  const leading = /^\s*/u.exec(run.text)?.[0] ?? ''
  const trailing = /\s*$/u.exec(run.text)?.[0] ?? ''
  let text = run.text.trim()
  if (!text) {
    return run.text
  }
  if (run.strikethrough) {
    text = `~${text}~`
  }
  if (run.italic) {
    text = `_${text}_`
  }
  if (run.bold) {
    text = `*${text}*`
  }

  const linked =
    run.href && run.href !== run.text ? `${text} (${run.href})` : text

  return `${leading}${linked}${trailing}`
}

export function whatsAppMarkdown(markdown: string): string {
  return markdownRuns(markdown).map(formatted).join('')
}

export function splitWhatsAppMarkdown(markdown: string): readonly string[] {
  return splitMarkdown(markdown, {
    maxLength: 4096,
    unit: 'utf16',
    measure: (part) => whatsAppMarkdown(part).length
  })
}
