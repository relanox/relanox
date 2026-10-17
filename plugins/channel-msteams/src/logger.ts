import { ConsoleLogger } from '@microsoft/teams.common'
import type { ILogger, LogLevel } from '@microsoft/teams.common'
import type { ChannelHost } from '@relanox/sdk'

/** SDK diagnostics must not expose activity contents, tokens, or request bodies. */
export class TeamsLogger extends ConsoleLogger {
  constructor(private readonly host: ChannelHost) {
    super('teams')
  }

  override log(level: LogLevel): void {
    if (level === 'error' || level === 'warn') {
      this.host.observe.log('warn', 'teams_sdk_error', {
        errorCode: 'sdk_error'
      })
    }
  }

  override child(): ILogger {
    return this
  }
}
