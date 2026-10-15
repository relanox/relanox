import { execFile } from 'node:child_process'
import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { expect, test } from 'vitest'
import { appConfigSchema } from '../src/config.js'
import { cli, fixture } from './fixture.js'

const execute = promisify(execFile)
const workspace = resolve(import.meta.dirname, '../../..')

test('the shipped all-channel example validates every native factory and both agents without opening storage', async () => {
  const value = await fixture()
  try {
    const input: unknown = JSON.parse(
      await readFile(
        new URL('../../../examples/relanox.all-channels.json', import.meta.url),
        'utf8'
      )
    )

    const config = appConfigSchema.parse(input)
    expect(
      config.relay.accounts.map((account) => account.channel).toSorted()
    ).toEqual([
      'dingtalk',
      'discord',
      'feishu',
      'googlechat',
      'irc',
      'line',
      'matrix',
      'mattermost',
      'msteams',
      'qq',
      'signal',
      'slack',
      'telegram',
      'wecom',
      'whatsapp'
    ])
    expect(
      config.relay.endpoints.map((endpoint) => endpoint.agent).toSorted()
    ).toEqual(['dot', 'grok'])
    await value.save({
      ...config,
      relay: {
        ...config.relay,
        storage: {
          plugin: 'sqlite',
          config: { filename: value.filename }
        }
      }
    })
    const validated = await cli(value.configPath, ['validate'])
    expect(validated.code).toBe(0)
    expect(validated.stderr).toBe('')
    expect(JSON.parse(validated.stdout)).toEqual({
      ok: true,
      accounts: 15,
      endpoints: 2
    })
    await expect(access(value.filename)).rejects.toThrow()
  } finally {
    await rm(value.directory, { recursive: true, force: true })
  }
})

// Protect the release assembly boundary: omitted per-deploy configuration breaks
// CLI/non-WeCom graphs, and a lost patch replays delayed accepted upload chunks.
// Pack/loader coverage never runs deploy. This uses the production script and
// Installed SDK with real sockets, without a test-only production interface.
test(
  'assembles isolated CLI and native SDK packages with the required WeCom patch',
  { timeout: 180_000 },
  async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'relanox-assembly-'))
    const destination = join(temporary, 'distribution')
    try {
      await execute(
        process.execPath,
        [
          'scripts/assemble-plugins.mts',
          destination,
          'channel-matrix channel-wecom channel-msteams'
        ],
        {
          cwd: workspace,
          timeout: 120_000,
          maxBuffer: 2 * 1024 * 1024,
          windowsHide: true
        }
      )

      const help = await execute(
        process.execPath,
        [join(destination, 'dist/main.js'), '--help'],
        { cwd: temporary, windowsHide: true }
      )

      expect(help.stdout).toContain('Usage: relanox')

      const probe = await execute(
        process.execPath,
        [join(import.meta.dirname, 'assembly-peer.mts'), destination],
        { cwd: temporary, timeout: 30_000, windowsHide: true }
      )

      expect(JSON.parse(probe.stdout)).toEqual({
        channels: ['matrix', 'msteams', 'wecom'],
        mediaId: 'assembled-media',
        chunks: 1
      })
      await expect(
        access(join(destination, 'node_modules/@relanox/channel-slack'))
      ).rejects.toThrow()
    } finally {
      await rm(temporary, { recursive: true, force: true })
    }
  }
)
