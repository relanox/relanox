import { markdownRuns, splitMarkdown } from '@relanox/markdown'
import type { MarkdownRun } from '@relanox/markdown'
import type { Json, ReplyTarget } from '@relanox/sdk'

type Element =
  | { type: 'text'; text: string; style?: Readonly<Record<string, boolean>> }
  | {
      type: 'link'
      text: string
      url: string
      style?: Readonly<Record<string, boolean>>
    }

function element(run: MarkdownRun): Element {
  const style = {
    ...(run.bold ? { bold: true } : {}),
    ...(run.italic ? { italic: true } : {}),
    ...(run.strikethrough ? { strike: true } : {}),
    ...(run.code ? { code: true } : {})
  }

  const attributes = {
    text: run.text,
    ...(Object.keys(style).length > 0 ? { style } : {})
  }

  return run.href
    ? { type: 'link', url: run.href, ...attributes }
    : { type: 'text', ...attributes }
}

function escaped(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

/** Rich-text elements represent literal text and links without Slack's mention parser. */
export function slackMarkdown(markdown: string): {
  text: string
  blocks: Json[]
} {
  const runs = markdownRuns(markdown)
  const sections: Json[] = []
  let elements: Element[] = []
  for (const run of runs) {
    if (!run.pre) {
      elements.push(element(run))
      continue
    }
    if (elements.length > 0) {
      sections.push({ type: 'rich_text_section', elements })
      elements = []
    }
    sections.push({
      type: 'rich_text_preformatted',
      elements: [{ type: 'text', text: run.text }]
    })
  }
  if (elements.length > 0) {
    sections.push({ type: 'rich_text_section', elements })
  }

  const text = runs
    .map((run) =>
      run.href && run.href !== run.text ? `${run.text} (${run.href})` : run.text
    )
    .join('')

  return {
    text: escaped(text),
    blocks: [{ type: 'rich_text', elements: sections }]
  }
}

export function splitSlackMarkdown(
  markdown: string,
  target: ReplyTarget
): readonly string[] {
  return splitMarkdown(markdown, {
    // Conservative payload budget also bounds escaped fallback text and styled-run overhead.
    maxLength: 4000,
    unit: 'utf8',
    measure: (part) =>
      Buffer.byteLength(
        JSON.stringify({
          channel: target.chatId,
          ...slackMarkdown(part),
          mrkdwn: false,
          parse: 'none',
          unfurl_links: false,
          unfurl_media: false,
          ...(target.threadId ? { thread_ts: target.threadId } : {})
        }),
        'utf8'
      )
  })
}
