import { markdownRuns, splitMarkdown } from '@relanox/markdown'
import type { MarkdownRun } from '@relanox/markdown'
import type { ReplyTarget } from '@relanox/sdk'
import { targetSchema } from './schemas.js'

function formatted(run: MarkdownRun): string {
  // Source control bytes cannot become CTCP frames or override generated styles.
  if (
    Array.from(run.text, (character) => character).some(
      (character) =>
        !['\n', '\r', '\t'].includes(character) &&
        ((character.codePointAt(0) ?? 0) < 32 ||
          (character.codePointAt(0) ?? 0) === 127)
    )
  ) {
    throw new Error('invalid_irc_control')
  }
  let text = run.text.replaceAll(/\r\n|[\r\n\t]/gu, ' ')

  const toggles =
    run.pre || run.code
      ? '\u0011'
      : `${run.bold ? '\u0002' : ''}${run.italic ? '\u001D' : ''}${run.strikethrough ? '\u001E' : ''}`

  text = toggles ? `${toggles}${text}\u000F` : text
  return run.href && run.href !== run.text ? `${text} (${run.href})` : text
}

export function ircMarkdown(markdown: string): string {
  return markdownRuns(markdown).map(formatted).join('')
}

export function splitIrcMarkdown(
  markdown: string,
  target: ReplyTarget
): readonly string[] {
  const { recipient } = targetSchema.parse(target.data)
  const maxLength = 510 - Buffer.byteLength(`PRIVMSG ${recipient} :`, 'utf8')
  return splitMarkdown(markdown, {
    maxLength,
    unit: 'utf8',
    measure: (part) => Buffer.byteLength(ircMarkdown(part), 'utf8')
  })
}
