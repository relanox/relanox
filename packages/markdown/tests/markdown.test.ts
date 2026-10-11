import { expect, test } from 'vitest'
import { markdownRuns, renderHtml, splitMarkdown } from '../src/index.js'

test('Markdown styles preserve visible Unicode, nested emphasis and decoded links for typed platform entities', () => {
  expect(
    markdownRuns(
      '😀 **bold _both_** [site](https://example.com?q=1&amp;x=2) `a < b`'
    )
  ).toEqual([
    { text: '😀 ' },
    { text: 'bold ', bold: true },
    { text: 'both', bold: true, italic: true },
    { text: ' ' },
    { text: 'site', href: 'https://example.com/?q=1&x=2' },
    { text: ' ' },
    { text: 'a < b', code: true }
  ])
})

test('generated HTML supports headings, lists and GFM while keeping raw HTML and unsafe destinations inert', () => {
  expect(renderHtml('# Heading\n\n- **one**\n- ~~two~~')).toBe(
    '<h1>Heading</h1>\n<ul>\n<li><strong>one</strong></li>\n<li><del>two</del></li>\n</ul>\n'
  )
  expect(
    renderHtml('<img src=x onerror=alert(1)>\n\n[bad](javascript:alert%281%29)')
  ).toBe('&lt;img src=x onerror=alert(1)&gt;<p>bad</p>\n')
  expect(renderHtml('[site](https://example.com)')).toBe(
    '<p><a href="https://example.com/">site</a></p>\n'
  )
})

test('splitting long fenced code keeps complete code fences and all original Unicode scalars', () => {
  const text = '😀中文\n'.repeat(12)

  const chunks = splitMarkdown(`\`\`\`ts\n${text}\`\`\``, {
    maxLength: 48,
    unit: 'utf8'
  })

  expect(chunks.length).toBeGreaterThan(1)
  for (const chunk of chunks) {
    expect(Buffer.byteLength(chunk)).toBeLessThanOrEqual(48)
    expect(chunk).toMatch(/^```ts\n[\s\S]*\n```$/u)
  }
  expect(chunks.map((chunk) => chunk.slice(6, -4)).join('')).toBe(
    text.replace(/\n$/u, '')
  )
})

test('splitting emphasis and reference links reopens complete markup without losing the destination', () => {
  const chunks = splitMarkdown(`**${'字'.repeat(40)}**`, {
    maxLength: 34,
    unit: 'utf8'
  })

  expect(chunks).toHaveLength(4)
  expect(chunks).toEqual(
    Array.from({ length: 4 }, () => `**${'字'.repeat(10)}**`)
  )

  const references = splitMarkdown(
    '[first][doc]\n\n[second][doc]\n\n[doc]: https://example.com',
    { maxLength: 35, unit: 'utf16' }
  )

  expect(references).toEqual([
    '[first](<https://example.com>)',
    '[second](<https://example.com>)'
  ])
})

test('destination size measurement splits escaped HTML before the platform limit is exceeded', () => {
  const chunks = splitMarkdown('**&&&&&&&&&&&&**', {
    maxLength: 48,
    unit: 'utf8',
    measure: (markdown) => Buffer.byteLength(renderHtml(markdown))
  })

  expect(chunks.length).toBeGreaterThan(1)
  for (const chunk of chunks) {
    expect(Buffer.byteLength(renderHtml(chunk))).toBeLessThanOrEqual(48)
  }
  expect(chunks.map((chunk) => chunk.slice(2, -2)).join('')).toBe(
    '&&&&&&&&&&&&'
  )
})

test('unsplittable links fail before enqueue instead of dropping their destination', () => {
  expect(() =>
    splitMarkdown(`[link](https://example.com/${'x'.repeat(100)})`, {
      maxLength: 40,
      unit: 'utf8'
    })
  ).toThrow('markdown_fragment_exceeds_limit')
  expect(() =>
    splitMarkdown('\uD800', { maxLength: 40, unit: 'utf8' })
  ).toThrow('malformed_markdown_unicode')
})

test('empty link and image labels retain visible destinations when rendered or split', () => {
  expect(
    markdownRuns('[](https://example.com) ![](https://example.com/a.png)')
  ).toEqual([
    { text: 'https://example.com/', href: 'https://example.com/' },
    { text: ' ' },
    { text: 'Image', href: 'https://example.com/a.png' }
  ])
  expect(renderHtml('[](https://example.com)')).toBe(
    '<p><a href="https://example.com/">https://example.com/</a></p>\n'
  )
  expect(
    splitMarkdown('![](https://example.com/a.png)\n\n**next**', {
      maxLength: 38,
      unit: 'utf8'
    })
  ).toEqual(['![Image](<https://example.com/a.png>)', '**next**'])
})

test('emphasis fragments keep spaces outside delimiters and remain styled', () => {
  const chunks = splitMarkdown('**abc def ghi jkl**', {
    maxLength: 12,
    unit: 'utf16'
  })

  expect(chunks).toEqual(['**abc def** ', '**ghi jkl**'])
  expect(chunks.map(renderHtml)).toEqual([
    '<p><strong>abc def</strong> </p>\n',
    '<p><strong>ghi jkl</strong></p>\n'
  ])
  expect(
    splitMarkdown('~~abc def ghi jkl~~', { maxLength: 12, unit: 'utf16' }).map(
      renderHtml
    )
  ).toEqual(['<p><del>abc def</del> </p>\n', '<p><del>ghi jkl</del></p>\n'])
})

test('paragraph splitting keeps indentation attached to preceding visible text', () => {
  const chunks = splitMarkdown(`${'a'.repeat(70)}    END`, {
    maxLength: 70,
    unit: 'utf16'
  })

  expect(chunks).toEqual(['a'.repeat(69), 'a    END'])
  expect(renderHtml(chunks[1] ?? '')).toBe('<p>a    END</p>\n')
})
