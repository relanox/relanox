import { markdownRuns, splitMarkdown } from '@relanox/markdown'
import type { MarkdownRun } from '@relanox/markdown'
import type { Json } from '@relanox/sdk'

function span(run: MarkdownRun): Json {
  return {
    type: 'span',
    text: run.text,
    ...(run.bold ? { weight: 'bold' } : {}),
    ...(run.italic ? { style: 'italic' } : {}),
    ...(run.strikethrough ? { decoration: 'line-through' } : {})
  }
}

function paragraph(runs: readonly MarkdownRun[]): Json {
  return { type: 'text', wrap: true, contents: runs.map(span) }
}

/** Flex provides inline styles; links need their own text component for a URI action. */
export function lineMarkdown(markdown: string): Json {
  const runs = markdownRuns(markdown)
  const contents: Json[] = []
  let paragraphRuns: MarkdownRun[] = []
  for (const run of runs) {
    if (!run.href) {
      paragraphRuns.push(run)
      continue
    }
    if (paragraphRuns.length > 0) {
      contents.push(paragraph(paragraphRuns))
      paragraphRuns = []
    }
    contents.push({
      type: 'text',
      wrap: true,
      contents: [span(run)],
      action: { type: 'uri', uri: run.href }
    })
  }
  if (paragraphRuns.length > 0) {
    contents.push(paragraph(paragraphRuns))
  }
  const visible = runs.map((run) => run.text).join('')
  const preview = visible.slice(0, 1500)
  return {
    type: 'flex',
    altText:
      (preview.isWellFormed() ? preview : preview.slice(0, -1)) || 'Message',
    contents: {
      type: 'bubble',
      body: { type: 'box', layout: 'vertical', contents }
    }
  }
}

export function splitLineMarkdown(markdown: string): readonly string[] {
  return splitMarkdown(markdown, {
    maxLength: 30_000,
    unit: 'utf8',
    measure: (part) =>
      Buffer.byteLength(JSON.stringify(lineMarkdown(part)), 'utf8')
  })
}
