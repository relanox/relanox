import { access, readFile, rm } from 'node:fs/promises'
import { expect, test } from 'vitest'
import { appConfigSchema } from '../src/config.js'
import { cli, fixture } from './fixture.js'

// Protect the shipped plugin set against missing CLI dependencies or stale examples.
// Plugin-local tests do not exercise CLI package resolution; no production seam is needed.
test('the shipped all-channel example validates every native factory and agent without opening storage', async () => {
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
      'wechat',
      'wecom',
      'whatsapp'
    ])
    expect(
      config.relay.endpoints.map((endpoint) => endpoint.agent).toSorted()
    ).toEqual(['dot', 'grok', 'muse'])
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
      accounts: 16,
      endpoints: 3
    })
    await expect(access(value.filename)).rejects.toThrow()
  } finally {
    await rm(value.directory, { recursive: true, force: true })
  }
})
