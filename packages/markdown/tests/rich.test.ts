import { expect, test } from 'vitest'
import { parseRichMarkdown, renderHtml } from '../src/index.js'

const id = '12345678-1234-1234-1234-123456789abc'
const uri = `relanox://media/${id}`

test('rich Markdown preserves text and media order and closes nested styles', () => {
  const parts = parseRichMarkdown(
    `**before _![photo](${uri}) after_** [file](relanox://attachment/2)`
  )

  expect(parts).toEqual([
    { type: 'text', text: '**before** ' },
    {
      type: 'media',
      reference: { kind: 'media', id },
      label: 'photo',
      image: true
    },
    { type: 'text', text: ' ***after*** ' },
    {
      type: 'media',
      reference: { kind: 'attachment', index: 2 },
      label: 'file',
      image: false
    }
  ])

  const html = parts
    .filter((part) => part.type === 'text')
    .map((part) => renderHtml(part.text))
    .join('')

  expect(html).toContain('<em><strong>after</strong></em>')
})

test('ordinary Markdown, escaped syntax, code and HTML remain byte exact', () => {
  for (const markdown of [
    '',
    '[site](https://example.com) ![external](https://example.com/a.png)',
    '![alt [literal](relanox://attachment/0)](https://example.com/image.png)',
    `\`![literal](${uri})\``,
    `\`\`\`md\n![literal](${uri})\n\`\`\``,
    String.raw`\!\[literal](relanox://attachment/0)`,
    '<img src="relanox://attachment/0">',
    '[text]: relanox://attachment/0'
  ]) {
    expect(parseRichMarkdown(markdown)).toEqual([
      { type: 'text', text: markdown }
    ])
  }
})

test('reference style links resolve destinations and decode entity labels', () => {
  const parts = parseRichMarkdown(`[A &amp; B][photo]\n\n[photo]: ${uri}`)
  expect(parts[0]).toEqual({
    type: 'media',
    reference: { kind: 'media', id },
    label: 'A & B',
    image: false
  })
})

test('invalid native link destinations fail before media resolution', () => {
  for (const destination of [
    'relanox://attachment/0',
    'relanox://attachment/01',
    'relanox://attachment/9007199254740992',
    'relanox://media/not-a-uuid',
    `${uri}?token=x`,
    'relanox://other/1',
    'RELANOX://attachment/1'
  ]) {
    expect(() => parseRichMarkdown(`[bad](${destination})`)).toThrow(
      'invalid_media_reference'
    )
  }
})

test('media inside lists, quotes and table cells is emitted in reading order', () => {
  const parts = parseRichMarkdown(
    `> ![one](${uri})\n\n- [two](relanox://attachment/1)\n\n| H |\n| - |\n| [three](relanox://attachment/2) |`
  )

  expect(
    parts.filter((part) => part.type === 'media').map((part) => part.label)
  ).toEqual(['one', 'two', 'three'])
})

test('ordinary reference destinations survive a media boundary without shared definitions', () => {
  const parts = parseRichMarkdown(
    `[site][web]\n\n![photo](${uri})\n\n[web]: https://example.com`
  )

  expect(parts[0]?.type).toBe('text')
  const first = parts[0]
  expect(first?.type === 'text' ? renderHtml(first.text) : '').toContain(
    '<a href="https://example.com/">site</a>'
  )
})

test('mixed media never reinterprets decoded or escaped literal Markdown', () => {
  const parts = parseRichMarkdown(
    `\\[literal](relanox://attachment/0) &lbrack;also literal](relanox://attachment/0) \`![code](relanox://attachment/0)\` ![real](${uri})`
  )

  expect(parts.filter((part) => part.type === 'media')).toEqual([
    {
      type: 'media',
      reference: { kind: 'media', id },
      label: 'real',
      image: true
    }
  ])
})

test('ordinary image alt remains literal beside a native image reference', () => {
  const parts = parseRichMarkdown(
    `![alt [literal](relanox://attachment/0)][external]\n\n![real](${uri})\n\n[external]: https://example.com/image.png`
  )

  expect(parts.filter((part) => part.type === 'media')).toEqual([
    {
      type: 'media',
      reference: { kind: 'media', id },
      label: 'real',
      image: true
    }
  ])
  expect(parts[0]).toEqual({
    type: 'text',
    text: '![alt [literal](relanox://attachment/0)](<https://example.com/image.png>)\n\n'
  })
})
