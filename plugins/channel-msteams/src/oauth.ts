import { ClientCredentials } from 'simple-oauth2'
import type { AccessToken } from 'simple-oauth2'
import { oauthTokenResponseSchema } from './schemas.js'

/** One client-credentials grant shared by sends and authenticated media reads. */
export class OAuthSession {
  private readonly client: ClientCredentials

  private token: AccessToken | undefined

  private pending: Promise<string> | undefined

  constructor(
    readonly endpoint: string,
    readonly appId: string,
    readonly credential: string
  ) {
    this.client = new ClientCredentials({
      client: { id: appId, secret: credential },
      auth: { tokenHost: new URL(endpoint).origin, tokenPath: endpoint },
      options: { authorizationMethod: 'body', bodyFormat: 'form' },
      http: { redirects: false, timeout: 10_000, maxBytes: 2 * 1024 * 1024 }
    })
  }

  invalidate(rejected: string): void {
    if (this.token?.token.access_token === rejected) {
      this.token = undefined
    }
  }

  async get(): Promise<string> {
    if (this.token && !this.token.expired(60)) {
      return oauthTokenResponseSchema.parse(this.token.token).access_token
    }
    this.pending ??= this.acquire().finally(() => {
      this.pending = undefined
    })
    return this.pending
  }

  private async acquire(): Promise<string> {
    const token = await this.client.getToken({
      scope: 'https://api.botframework.com/.default'
    })

    const parsed = oauthTokenResponseSchema.parse(token.token)
    if (
      !(token.token.expires_at instanceof Date) ||
      !Number.isFinite(token.token.expires_at.getTime())
    ) {
      throw new Error('invalid_oauth_expiry')
    }
    this.token = token
    return parsed.access_token
  }
}

/** A canceled waiter leaves the bounded shared exchange available to other callers. */
export async function sessionToken(
  session: OAuthSession,
  signal: AbortSignal
): Promise<string> {
  signal.throwIfAborted()
  return new Promise<string>((resolve, reject) => {
    const aborted = (): void => {
      reject(new Error('oauth_canceled', { cause: signal.reason }))
    }

    signal.addEventListener('abort', aborted, { once: true })
    void session
      .get()
      .then(resolve, reject)
      .finally(() => {
        signal.removeEventListener('abort', aborted)
      })
  })
}
