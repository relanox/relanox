import { hostedCases } from './hosted-channel-cases.js'
import { otherCases } from './channel-url-cases.js'
import { describe, expect, it } from 'vitest'
import { createLineChannel } from '../../plugins/channel-line/src/index.js'
import { createGoogleChatChannel } from '../../plugins/channel-googlechat/src/index.js'

const boundaries = otherCases.flatMap((entry) =>
  ['?route=bot', '?', '#', '#fragment'].map((suffix) => ({
    name: entry.name,
    plugin: entry.plugin,
    config: entry.config,
    field: entry.field,
    suffix
  }))
)

describe('channel API base URL contract', () => {
  it.each(boundaries)(
    "$name rejects API base suffix '$suffix' before any request",
    ({ plugin, config, field, suffix }) => {
      expect(() =>
        plugin.validateConfig({
          ...config,
          [field]: 'https://api.example/proxy%3F%23/'
        })
      ).not.toThrow()
      expect(() =>
        plugin.validateConfig({
          ...config,
          [field]: `https://api.example/proxy/${suffix}`
        })
      ).toThrow()
    }
  )

  it.each(
    hostedCases.flatMap((entry) =>
      entry.fields.map((field) => ({ ...entry, field }))
    )
  )(
    '$name rejects removed hosted setting $field while accepting minimal credentials offline',
    ({ plugin, config, field }) => {
      expect(() => plugin.validateConfig(config)).not.toThrow()
      expect(() =>
        plugin.validateConfig({
          ...config,
          [field]: 'https://operator.example'
        })
      ).toThrow()
    }
  )

  it.each(['apiBase', 'tokenUrl', 'jwksUrl', 'allowLoopback'])(
    'rejects removed Google Chat endpoint setting %s',
    (field) => {
      expect(() =>
        createGoogleChatChannel().validateConfig({
          serviceAccount: { env: 'SERVICE' },
          [field]: 'https://operator.example'
        })
      ).toThrow()
    }
  )

  it.each(['botUserId', 'apiBase', 'contentApiBase', 'allowLoopback'])(
    'rejects removed LINE setting %s',
    (field) => {
      expect(() =>
        createLineChannel().validateConfig({
          channelSecret: { env: 'SECRET' },
          accessToken: { env: 'TOKEN' },
          [field]: 'https://operator.example'
        })
      ).toThrow()
    }
  )
})
