import type { AgentPlugin, DispatchResult } from '@relanox/sdk'
import { configSchema } from './config.js'
import type { GrokConfig } from './config.js'
import { projectAgentRequest, resolveAgentSecret } from '@relanox/agent-mcp'

function classifyReceipt(response: Response): DispatchResult {
  if (response.ok) {
    return { status: 'accepted' }
  }
  if (response.status === 408) {
    return { status: 'unknown', errorCode: 'grok_http_408' }
  }
  if (response.status === 429 || response.status >= 500) {
    const retry = response.headers.get('retry-after')
    let millis: number | undefined
    if (retry !== null && retry.length > 0) {
      millis = /^\d+$/u.test(retry)
        ? Number(retry) * 1000
        : Date.parse(retry) - Date.now()
    }
    return {
      status: 'retryable',
      errorCode: `grok_http_${response.status}`,
      ...(millis !== undefined && Number.isFinite(millis) && millis >= 0
        ? { retryAfterMs: Math.min(millis, 3_600_000) }
        : {})
    }
  }
  return { status: 'rejected', errorCode: `grok_http_${response.status}` }
}

export const dispatchRoutine: AgentPlugin<GrokConfig>['dispatch'] = async ({
  request,
  signal
}) => {
  const config = configSchema.parse(request.endpoint.config)
  let url: URL
  let authorization: string
  try {
    url = new URL(resolveAgentSecret(config.routineUrl))
    authorization = resolveAgentSecret(config.routineAuthorization)
  } catch {
    return { status: 'rejected', errorCode: 'grok_credentials_invalid' }
  }
  if (
    url.username ||
    url.password ||
    url.hash ||
    (config.routineTransport === 'https'
      ? url.protocol !== 'https:'
      : url.protocol !== 'http:' ||
        !['127.0.0.1', '[::1]'].includes(url.hostname))
  ) {
    return { status: 'rejected', errorCode: 'grok_routine_url_invalid' }
  }
  const content = JSON.stringify(projectAgentRequest(request))

  const body = JSON.stringify({
    content,
    source: 'relanox',
    sentAt: new Date(request.acceptedAt).toISOString()
  })

  if (Buffer.byteLength(body) > config.maxBodyBytes) {
    return { status: 'rejected', errorCode: 'grok_body_too_large' }
  }
  try {
    const response = await fetch(url, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authorization
      },
      body,
      signal: AbortSignal.any([signal, AbortSignal.timeout(config.timeoutMs)])
    })

    try {
      await response.body?.cancel()
    } catch {
      // Receipt classification is already determined by the response headers.
    }
    return classifyReceipt(response)
  } catch {
    return { status: 'unknown', errorCode: 'grok_trigger_uncertain' }
  }
}
