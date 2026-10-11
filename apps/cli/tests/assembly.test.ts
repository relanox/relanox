import { access, readFile, rm } from 'node:fs/promises'
import { expect, test } from 'vitest'
import { appConfigSchema } from '../src/config.js'
import { cli, fixture } from './fixture.js'

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
