import { rm } from 'node:fs/promises'
import { afterEach, expect, it, vi } from 'vitest'
import { appConfigSchema } from '../src/config.js'
import { missingSecrets } from '../src/admin.js'
import { startRuntime } from '../src/runtime.js'
import { cli, fixture } from './fixture.js'

afterEach(() => vi.unstubAllEnvs())

const speech = {
  plugin: 'tencent',
  config: {
    secretId: { env: 'TEST_ASR_ID' },
    secretKey: { env: 'TEST_ASR_KEY' }
  }
}

const relay = {
  accounts: [],
  endpoints: [],
  bindings: [],
  storage: { plugin: 'sqlite', config: { filename: ':memory:' } },
  observability: { plugin: 'none', config: {} }
}

it('keeps speech opt-in, supplies the default engine and only accepts environment credential references', () => {
  expect(appConfigSchema.parse({ relay }).speechToText).toBeUndefined()
  expect(
    appConfigSchema.parse({ relay, speechToText: speech }).speechToText
  ).toEqual({ ...speech, config: { ...speech.config, engine: '16k_zh' } })
  for (const value of [
    { ...speech.config, secretKey: undefined },
    { ...speech.config, secretKey: 'literal-secret' },
    { ...speech.config, secretId: { env: '' } },
    { ...speech.config, engine: 'typo' },
    { ...speech.config, apiKey: 'literal-secret' }
  ]) {
    expect(() =>
      appConfigSchema.parse({
        relay,
        speechToText: { ...speech, config: value }
      })
    ).toThrow()
  }
  expect(() =>
    appConfigSchema.parse({
      relay,
      speechToText: { ...speech, plugin: 'other' }
    })
  ).toThrow()
})

it('reports missing top-level credentials and fails startup instead of silently disabling transcription', async () => {
  vi.stubEnv('TEST_ASR_ID', '')
  vi.stubEnv('TEST_ASR_KEY', '')

  const config = appConfigSchema.parse({
    relay,
    speechToText: speech,
    server: { port: 0, managementPort: 0 }
  })

  expect(missingSecrets(config)).toEqual(['TEST_ASR_ID', 'TEST_ASR_KEY'])
  await expect(startRuntime(config)).rejects.toMatchObject({
    code: 'speech_credentials_missing'
  })
  vi.stubEnv('TEST_ASR_ID', 'private-secret-id')
  expect(missingSecrets(config)).toEqual(['TEST_ASR_KEY'])
  await expect(startRuntime(config)).rejects.toMatchObject({
    code: 'speech_credentials_missing'
  })
})

it('makes a missing speech credential actionable at the CLI without printing the other secret', async () => {
  const value = await fixture()
  vi.stubEnv('TEST_ASR_ID', 'private-secret-id')
  vi.stubEnv('TEST_ASR_KEY', '')
  try {
    await value.save({ ...value.config, speechToText: speech })
    const result = await cli(value.configPath, ['run'])
    expect(result.code).toBe(1)
    expect(JSON.parse(result.stderr)).toEqual({
      ok: false,
      errorCode: 'speech_credentials_missing'
    })
    expect(result.stdout + result.stderr).not.toContain('private-secret-id')
  } finally {
    await rm(value.directory, { recursive: true, force: true })
  }
})
