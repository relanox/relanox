import { App } from '@microsoft/teams.apps'
import type { HttpRouteHandler } from '@microsoft/teams.apps'
import { PUBLIC } from '@microsoft/teams.api'
import type { Activity, Client, InvokeResponse } from '@microsoft/teams.api'
import type { RequestContext } from '@microsoft/teams.common'
import { TeamsLogger } from './logger.js'
import type { ChannelHost } from '@relanox/sdk'
import { parseBody, rawBody, secret } from './io.js'
import type { TeamsConfig } from './config.js'
import { validateEndpointUrl } from './config.js'

/** The official SDK owns authentication, Activity dispatch, tokens, and API calls. */
export class TeamsClient {
  private active:
    { credential: string; app: App; ready: Promise<void> } | undefined

  private handler: HttpRouteHandler | undefined

  private readonly logger: TeamsLogger

  constructor(
    host: ChannelHost,
    private readonly config: TeamsConfig,
    private readonly receive: (activity: Activity) => Promise<InvokeResponse>
  ) {
    this.logger = new TeamsLogger(host)
    host.mountHttp('/activities', async (incoming) => {
      if (incoming.method !== 'POST') {
        return new Response(null, { status: 405 })
      }
      await this.app()
      const body: unknown = parseBody(await rawBody(incoming))
      if (body === null || typeof body !== 'object' || Array.isArray(body)) {
        return new Response(null, { status: 400 })
      }
      if (!this.handler) {
        throw new Error('teams_sdk_not_initialized')
      }

      const response = await this.handler({
        body,
        headers: Object.fromEntries(incoming.headers)
      })

      return response.body === undefined
        ? new Response(null, { status: response.status })
        : Response.json(response.body, { status: response.status })
    })
  }

  async app(): Promise<App> {
    const credential = secret(this.config.appSecret)
    if (!this.active || this.active.credential !== credential) {
      const endpoint = new URL(this.config.tokenUrl)

      const app = new App({
        clientId: this.config.appId,
        clientSecret: credential,
        tenantId: endpoint.pathname.split('/')[1] ?? 'botframework.com',
        cloud: { ...PUBLIC, loginEndpoint: endpoint.origin },
        logger: this.logger,
        client: {
          timeout: 10_000,
          logger: this.logger,
          interceptors: [
            {
              request: ({ config }): RequestContext['config'] => ({
                ...config,
                maxRedirects: 0
              })
            }
          ]
        },
        dangerouslyAllowUnauthenticatedRequests: false,
        state: false,
        telemetry: { agent365: false },
        activity: { mentions: { stripText: false } },
        messagingEndpoint: '/activities',
        httpServerAdapter: {
          registerRoute: (_method, _path, handler): void => {
            this.handler = handler
          }
        }
      })

      app.use(async ({ activity }) => this.receive(activity))
      this.active = { credential, app, ready: app.initialize() }
    }
    await this.active.ready
    return this.active.app
  }

  invalidate(): void {
    this.active = undefined
  }

  async accessToken(): Promise<string> {
    const token = await (
      await this.app()
    ).tokenProvider
      .getAppToken()
      .catch((error: unknown) => {
        if (error instanceof Error && error.name === 'InvalidTokenError') {
          this.invalidate()
        }
        throw error
      })

    if (!token) {
      throw new Error('oauth_unavailable')
    }
    return token.toString()
  }

  async api(base: string, signal: AbortSignal): Promise<Client> {
    const app = await this.app()
    const client = app.api.clone({ serviceUrl: base })
    client.http.use({
      request: ({ config }): RequestContext['config'] => ({ ...config, signal })
    })
    return client
  }
}

export function serviceUrl(value: string, config: TeamsConfig): URL {
  const url = validateEndpointUrl(value)
  if (
    /[?#]/u.test(url.href) ||
    !config.trustedServiceOrigins.includes(url.origin)
  ) {
    throw new Error('untrusted_service_origin')
  }
  return url
}
