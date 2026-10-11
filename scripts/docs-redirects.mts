import { mkdir, readdir, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'

const source = resolve(process.argv[2] ?? 'docs/.vitepress/dist')
const destination = resolve(process.argv[3] ?? 'docs/.vitepress/redirects')

async function redirectPages(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      await redirectPages(path)
    } else if (entry.isFile() && entry.name.endsWith('.html')) {
      const page = relative(source, path).split(sep).join('/')

      const target = new URL(
        page.replace(/index\.html$/u, ''),
        'https://relanox.github.io/'
      ).href

      const output = join(destination, page)
      await mkdir(dirname(output), { recursive: true })
      await writeFile(
        output,
        `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>Relanox documentation has moved</title>
<link rel="canonical" href="${target}">
<script>location.replace(${JSON.stringify(target)} + location.search + location.hash)</script>
</head><body><p>Documentation has moved to <a href="${target}">${target}</a>.</p></body></html>
`
      )
    }
  }
}

await mkdir(destination, { recursive: true })
await redirectPages(source)
await writeFile(join(destination, '.nojekyll'), '')
