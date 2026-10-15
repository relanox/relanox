import { markdownRuns, safeLink, splitMarkdown } from '@relanox/markdown'
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
export function lineContents(markdown: string): Json[] {
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
  return contents
}

export function lineMarkdown(markdown: string): Json {
  const contents = lineContents(markdown)

  const visible = markdownRuns(markdown)
    .map((run) => run.text)
    .join('')

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
    maxLength: 5000,
    unit: 'utf16',
    measure: (part) =>
      Math.max(
        quotedPlainText(part).length,
        // Normalize the Flex 30,000-byte ceiling to the text 5,000-unit budget.
        Math.ceil(
          Buffer.byteLength(JSON.stringify(lineMarkdown(part)), 'utf8') / 6
        )
      )
  })
}

export function quotedText(text: string, quoteToken: string | undefined): Json {
  return quoteToken
    ? { type: 'text', text: quotedPlainText(text), quoteToken }
    : lineMarkdown(text)
}

function quotedPlainText(markdown: string): string {
  const links: MarkdownRun[] = []
  for (const run of markdownRuns(markdown)) {
    const previous = links.at(-1)
    if (run.href && previous?.href === run.href) {
      links[links.length - 1] = {
        text: previous.text + run.text,
        href: run.href
      }
    } else {
      links.push(run)
    }
  }
  return links
    .map((run) =>
      run.href && safeLink(run.text) !== run.href
        ? `${run.text} (${run.href})`
        : run.text
    )
    .join('')
}
