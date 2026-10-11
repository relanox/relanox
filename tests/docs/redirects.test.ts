import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { runInNewContext } from 'node:vm'
import { expect, it, vi } from 'vitest'

const execute = promisify(execFile)

it('redirects old entry and deep links to the root site without losing query or fragment', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'relanox-docs-'))
  const source = join(directory, 'source')
  const output = join(directory, 'output')
  try {
    await mkdir(join(source, 'zh-CN/channels'), { recursive: true })
    await writeFile(join(source, 'index.html'), '<h1>Docs</h1>')
    await writeFile(join(source, 'zh-CN/index.html'), '<h1>中文</h1>')
    await writeFile(join(source, 'zh-CN/channels/qq.html'), '<h1>QQ</h1>')
    await execute(process.execPath, [
      resolve('scripts/docs-redirects.mts'),
      source,
      output
    ])
    for (const [page, target] of [
      ['index.html', 'https://relanox.github.io/'],
      ['zh-CN/index.html', 'https://relanox.github.io/zh-CN/'],
      [
        'zh-CN/channels/qq.html',
        'https://relanox.github.io/zh-CN/channels/qq.html'
      ]
    ]) {
      if (!page || !target) {
        throw new Error('Missing redirect fixture')
      }
      const html = await readFile(join(output, page), 'utf8')

      const script = /<script>(?<script>.*?)<\/script>/su.exec(html)?.groups
        ?.script

      expect(html).toContain(`<a href="${target}">`)
      expect(script).toBeDefined()
      const replace = vi.fn()
      runInNewContext(script ?? '', {
        location: { replace, search: '?source=old', hash: '#media' }
      })
      expect(replace).toHaveBeenCalledExactlyOnceWith(
        `${target}?source=old#media`
      )
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
