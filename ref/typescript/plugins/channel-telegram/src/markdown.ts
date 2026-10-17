import { markdownRuns, splitMarkdown, textLength } from '@relanox/markdown'
import type { MarkdownRun } from '@relanox/markdown'

type Entity = {
  readonly type: string
  readonly offset: number
  readonly length: number
  readonly url?: string
  readonly language?: string
}

function runEntities(run: MarkdownRun, offset: number): Entity[] {
  const range = { offset, length: run.text.length }
  if (run.pre) {
    return [
      {
        type: 'pre',
        ...range,
        ...(run.language ? { language: run.language } : {})
      }
    ]
  }
  if (run.code) {
    return [{ type: 'code', ...range }]
  }
  const entities: Entity[] = []
  if (run.bold) {
    entities.push({ type: 'bold', ...range })
  }
  if (run.italic) {
    entities.push({ type: 'italic', ...range })
  }
  if (run.strikethrough) {
    entities.push({ type: 'strikethrough', ...range })
  }
  if (run.href) {
    entities.push({ type: 'text_link', ...range, url: run.href })
  }
  return entities
}

/** Telegram entities use UTF-16 offsets even though visible message limits count characters. */
export function telegramMarkdown(markdown: string): {
  text: string
  entities?: Entity[]
} {
  let text = ''
  const entities: Entity[] = []
  for (const run of markdownRuns(markdown)) {
    entities.push(...runEntities(run, text.length))
    text += run.text
  }
  return { text, ...(entities.length > 0 ? { entities } : {}) }
}

export function splitTelegramMarkdown(markdown: string): readonly string[] {
  return splitMarkdown(markdown, {
    maxLength: 4096,
    unit: 'codepoint',
    measure: (part) => textLength(telegramMarkdown(part).text, 'codepoint')
  })
}
