export class ApiError extends Error {
  override readonly name = 'ApiError'

  constructor(
    readonly code: number,
    readonly httpStatus?: number
  ) {
    super('wechat_api_error')
  }
}
