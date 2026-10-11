import type { Client } from '@modelcontextprotocol/client'
import type { AgentId, AgentPlugin } from '@relanox/sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { createDotAgentPlugin } from '../src/index.js'
import { createGrokAgentPlugin } from '../../agent-grok/src/index.js'
import { fixture, mcp } from './fixture.js'

const cleanups: (() => Promise<void>)[] = []

beforeEach(() => {
  process.env.AGENT_TEST_TOKEN_0 = 'secret-0'
  process.env.AGENT_TEST_TOKEN_1 = 'secret-1'
})

afterEach(async () => {
  vi.restoreAllMocks()
  for (const cleanup of cleanups.splice(0).toReversed()) {
    await cleanup()
  }
  delete process.env.AGENT_TEST_TOKEN_0
  delete process.env.AGENT_TEST_TOKEN_1
})

const plugin = (agent: AgentId): AgentPlugin<unknown> =>
  agent === 'dot' ? createDotAgentPlugin() : createGrokAgentPlugin()

async function setup(agent: AgentId): ReturnType<typeof fixture> {
  const base =
    agent === 'dot'
      ? {}
      : {
          routineUrl: { env: 'UNUSED_ROUTINE_URL' },
          routineAuthorization: { env: 'UNUSED_ROUTINE_AUTH' }
        }

  const fx = await fixture(agent, plugin(agent), [
    { ...base, mcp: mcp() },
    { ...base, mcp: mcp('AGENT_TEST_TOKEN_1') }
  ])

  cleanups.push(async () => fx.close())
  return fx
}

const offerSchema = z.object({
  uploadUrl: z.url(),
  method: z.literal('PUT'),
  headers: z.object({ 'Content-Type': z.string() }),
  expiresAt: z.iso.datetime()
})

type Offer = z.infer<typeof offerSchema>

const file = {
  kind: 'file',
  mimeType: 'application/octet-stream',
  fileName: '结果.bin',
  size: 3
}

async function offer(
  client: Client,
  replyTo: string,
  metadata: Record<string, unknown> = {}
): Promise<Offer> {
  const result = await client.callTool({
    name: 'relanox_create_upload',
    arguments: { ...file, replyTo, ...metadata }
  })

  expect(result.isError).not.toBe(true)
  expect(result.structuredContent).not.toHaveProperty('fileId')
  return offerSchema.parse(result.structuredContent)
}

function put(ticket: Offer, bytes = new Uint8Array([0, 128, 255])): Request {
  return new Request(ticket.uploadUrl, {
    method: ticket.method,
    headers: ticket.headers,
    body: new Uint8Array(bytes)
  })
}

describe.each(['dot', 'grok'] as const)('%s signed file uploads', (agent) => {
  it('uploads raw bytes, retries across restart and sends the persisted ID without reuploading', async () => {
    const fx = await setup(agent)
    const receipt = await fx.ingest()
    // Seed a completed notification through the real storage lifecycle.
    const now = Date.now()

    const work = (
      await fx.storage.takeDue({
        now,
        leaseMs: 30_000,
        limit: 1,
        leaseOwner: 'test',
        safeRetryAccountIds: []
      })
    )[0]

    if (work?.kind !== 'dispatch') {
      throw new Error('missing_dispatch')
    }
    expect(
      await fx.storage.settleAttempt({
        kind: 'dispatch',
        id: receipt.requestId,
        lease: work.lease,
        outcome: { status: 'accepted' },
        now,
        nextDueAt: now
      })
    ).toMatchObject({ status: 'updated' })
    const client = await fx.client()
    const ticket = await offer(client, receipt.requestId)
    expect(ticket.uploadUrl).not.toContain('secret-0')
    expect(Date.parse(ticket.expiresAt) - Date.now()).toBeGreaterThan(290_000)
    const uploaded = await fx.core.fetch(put(ticket))
    expect(uploaded.status).toBe(200)

    const { fileId } = z
      .object({ fileId: z.uuid() })
      .parse(await uploaded.json())

    expect(
      (await fx.storage.media?.get(receipt.requestId, fileId))?.data
    ).toEqual(new Uint8Array([0, 128, 255]))
    expect(await fx.storage.listOutbound({ limit: 10 })).toEqual([])

    await fx.reopen(plugin(agent))
    const retry = await fx.core.fetch(put(ticket))
    expect(retry.status).toBe(200)
    expect(await retry.json()).toEqual({ fileId })
    expect(
      (await fx.core.fetch(put(ticket, new Uint8Array([1, 2, 3])))).status
    ).toBe(409)

    const reconnected = await fx.client()

    const args = {
      replyTo: receipt.requestId,
      text: '',
      idempotencyKey: 'uploaded-answer',
      attachments: [{ mediaId: fileId }]
    }

    expect(
      await reconnected.callTool({
        name: 'relanox_send_message',
        arguments: args
      })
    ).toMatchObject({ structuredContent: { status: 'queued', replay: false } })
    expect(
      await reconnected.callTool({
        name: 'relanox_send_message',
        arguments: args
      })
    ).toMatchObject({ structuredContent: { status: 'queued', replay: true } })
    await fx.core.processDue()
    expect(fx.sent).toMatchObject([
      {
        media: {
          data: new Uint8Array([0, 128, 255]),
          reference: {
            id: fileId,
            fileName: '结果.bin',
            mimeType: 'application/octet-stream'
          }
        }
      }
    ])
    expect(
      await fx.storage.cleanup({ before: Date.now() + 1000, limit: 10 })
    ).toEqual({ redacted: 1 })
    expect((await fx.core.fetch(put(ticket))).status).toBe(404)
    expect(
      await fx.storage.media?.get(receipt.requestId, fileId)
    ).toBeUndefined()
  })

  it('rejects forged, expired, cross-endpoint and wrong-method capabilities', async () => {
    const fx = await setup(agent)
    const receipt = await fx.ingest()
    const client = await fx.client()
    const other = await fx.client('secret-1', 1)
    expect(
      await other.callTool({
        name: 'relanox_create_upload',
        arguments: { ...file, replyTo: receipt.requestId }
      })
    ).toMatchObject({ isError: true })
    const ticket = await offer(client, receipt.requestId)
    const tampered = new URL(ticket.uploadUrl)
    tampered.searchParams.set(
      'ticket',
      `${tampered.searchParams.get('ticket')}x`
    )
    expect(
      (await fx.core.fetch(put({ ...ticket, uploadUrl: tampered.href }))).status
    ).toBe(401)
    expect(
      (
        await fx.core.fetch(
          put({
            ...ticket,
            uploadUrl: ticket.uploadUrl.replace('endpoint0', 'endpoint1')
          })
        )
      ).status
    ).toBe(401)
    expect((await fx.core.fetch(new Request(ticket.uploadUrl))).status).toBe(
      401
    )
    expect(
      (
        await fx.core.fetch(
          new Request(ticket.uploadUrl, {
            method: 'PUT',
            headers: { ...ticket.headers, origin: 'https://evil.example' },
            body: 'abc'
          })
        )
      ).status
    ).toBe(401)
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 300_001)
    expect((await fx.core.fetch(put(ticket))).status).toBe(401)
    clock.mockRestore()
    process.env.AGENT_TEST_TOKEN_0 = 'rotated'
    expect((await fx.core.fetch(put(ticket))).status).toBe(401)
  })

  it('checks signed MIME and actual byte size before saving and accepts a corrected retry', async () => {
    const fx = await setup(agent)
    const receipt = await fx.ingest()
    const ticket = await offer(await fx.client(), receipt.requestId)
    expect(
      (
        await fx.core.fetch(
          new Request(ticket.uploadUrl, {
            method: 'PUT',
            headers: { 'Content-Type': 'text/plain' },
            body: 'abc'
          })
        )
      ).status
    ).toBe(415)
    expect(
      (await fx.core.fetch(put(ticket, new Uint8Array([1, 2])))).status
    ).toBe(400)
    expect(
      (await fx.core.fetch(put(ticket, new Uint8Array([1, 2, 3, 4])))).status
    ).toBe(400)
    expect(
      (
        await fx.core.fetch(
          new Request(ticket.uploadUrl, {
            method: 'PUT',
            headers: { ...ticket.headers, 'Content-Length': '4' },
            body: 'abc'
          })
        )
      ).status
    ).toBe(400)
    expect((await fx.core.fetch(put(ticket))).status).toBe(200)
  })

  it.each([
    { fileName: '../file' },
    { fileName: '..' },
    { fileName: 'bad\nname' },
    { mimeType: 'image/png; charset=utf-8' },
    { kind: 'audio', mimeType: 'image/png' },
    { size: 0 },
    { size: 26 * 1024 * 1024 },
    { durationMs: -1 }
  ])('does not issue unusable upload instructions for %j', async (metadata) => {
    const fx = await setup(agent)
    const receipt = await fx.ingest()
    const client = await fx.client()
    expect(
      await client.callTool({
        name: 'relanox_create_upload',
        arguments: { ...file, replyTo: receipt.requestId, ...metadata }
      })
    ).toMatchObject({ isError: true })
  })

  it('reports aggregate storage quota as HTTP 413 without invalidating a successful retry', async () => {
    const fx = await setup(agent)
    const receipt = await fx.ingest()
    const client = await fx.client()
    const first = await offer(client, receipt.requestId)
    expect((await fx.core.fetch(put(first))).status).toBe(200)
    for (let index = 1; index < 20; index++) {
      expect(
        (await fx.core.fetch(put(await offer(client, receipt.requestId))))
          .status
      ).toBe(200)
    }

    const rejected = await fx.core.fetch(
      put(await offer(client, receipt.requestId))
    )

    expect(rejected.status).toBe(413)
    expect(await rejected.json()).toEqual({ error: 'too_many_attachments' })
    expect((await fx.core.fetch(put(first))).status).toBe(200)
  })
})
