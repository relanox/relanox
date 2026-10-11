import { Marked } from 'marked'
import { safeLink } from './runs.js'

export function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

const parser = new Marked({
  gfm: true,
  async: false,
  renderer: {
    html(token): string {
      return escapeHtml(token.text)
    },

    link(token): string {
      const label = this.parser.parseInline(token.tokens)
      const href = safeLink(token.href)
      return href ? `<a href="${escapeHtml(href)}">${label}</a>` : label
    },

    image(token): string {
      // Matrix accepts uploaded media separately; arbitrary remote HTML images are not embedded.
      const label = this.parser.parseInline(token.tokens)
      const href = safeLink(token.href)
      return href
        ? `<a href="${escapeHtml(href)}">${label || 'Image'}</a>`
        : label
    },

    checkbox(token): string {
      return token.checked ? '[x] ' : '[ ] '
    }
  }
})

/** Only generated Markdown tags are emitted; raw HTML is inert and links are allowlisted. */
export function renderHtml(markdown: string): string {
  return parser.parse(markdown, { async: false })
}
