import { createRequire } from 'node:module'
import type RobotModule from '@alicloud/dingtalk/dist/robot_1_0/client.js'
import type { BatchSendOTOResponseBody } from '@alicloud/dingtalk/dist/robot_1_0/client.js'
import type OAuthModule from '@alicloud/dingtalk/dist/oauth2_1_0/client.js'
import { Config } from '@alicloud/openapi-client'
import { RuntimeOptions } from '@alicloud/tea-util'
import type { DingTalkConfig } from './config.js'
import { secret } from './transport.js'

// The generated SDK is CommonJS. Load only the two services this channel uses.
const require = createRequire(import.meta.url)
const Robot = require('@alicloud/dingtalk/robot_1_0') as typeof RobotModule
const OAuth = require('@alicloud/dingtalk/oauth2_1_0') as typeof OAuthModule

const RobotClient = Robot.default
const OAuthClient = OAuth.default

const runtime = (): RuntimeOptions =>
  new RuntimeOptions({
    autoretry: false,
    maxAttempts: 1,
    readTimeout: 10_000,
    connectTimeout: 10_000
  })

export class DingTalkApi {
  private readonly robot: InstanceType<typeof RobotClient>
  private readonly oauth: InstanceType<typeof OAuthClient>

  constructor(private readonly config: DingTalkConfig) {
    const options = new Config({
      protocol: 'https',
      regionId: 'central',
      endpoint: 'api.dingtalk.com'
    })

    this.robot = new RobotClient(options)
    this.oauth = new OAuthClient(options)
  }

  async token(signal: AbortSignal): Promise<string> {
    signal.throwIfAborted()

    const response = await this.oauth.getAccessTokenWithOptions(
      new OAuth.GetAccessTokenRequest({
        appKey: this.config.clientId,
        appSecret: secret(this.config.clientSecret)
      }),
      {},
      runtime()
    )

    if (!response.body?.accessToken) {
      throw new Error('missing_access_token')
    }
    return response.body.accessToken
  }

  async downloadUrl(code: string, token: string): Promise<string> {
    const response = await this.robot.robotMessageFileDownloadWithOptions(
      new Robot.RobotMessageFileDownloadRequest({
        downloadCode: code,
        robotCode: this.config.robotCode
      }),
      new Robot.RobotMessageFileDownloadHeaders({
        xAcsDingtalkAccessToken: token
      }),
      runtime()
    )

    if (!response.body?.downloadUrl) {
      throw new Error('missing_download_url')
    }
    return response.body.downloadUrl
  }

  async send(
    target:
      | { type: 'single'; staffId: string }
      | { type: 'group'; openConversationId: string },
    payload: { msgKey: string; msgParam: string },
    token: string,
    signal: AbortSignal
  ): Promise<
    Pick<
      BatchSendOTOResponseBody,
      'processQueryKey' | 'invalidStaffIdList' | 'flowControlledStaffIdList'
    >
  > {
    signal.throwIfAborted()
    const body = { robotCode: this.config.robotCode, ...payload }
    const headers = { xAcsDingtalkAccessToken: token }

    const response =
      target.type === 'group'
        ? await this.robot.orgGroupSendWithOptions(
            new Robot.OrgGroupSendRequest({
              ...body,
              openConversationId: target.openConversationId
            }),
            new Robot.OrgGroupSendHeaders(headers),
            runtime()
          )
        : await this.robot.batchSendOTOWithOptions(
            new Robot.BatchSendOTORequest({
              ...body,
              userIds: [target.staffId]
            }),
            new Robot.BatchSendOTOHeaders(headers),
            runtime()
          )

    if (!response.body) {
      throw new Error('missing_message_response')
    }
    return response.body
  }
}
