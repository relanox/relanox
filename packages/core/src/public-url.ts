import { validatePublicUrl } from '@relanox/sdk'
import type { RelanoxConfig } from '@relanox/sdk'
import { CoreError } from './errors.js'

/** Validate deployment requirements before plugin setup or application resources. */
export function validatePublicDeployment(
  publicUrl: string | undefined,
  config: RelanoxConfig,
  mediaConfigured = false
): string | undefined {
  if (publicUrl !== undefined) {
    return validatePublicUrl(publicUrl)
  }
  if (
    config.endpoints.length > 0 ||
    config.accounts.some((account) => account.channel === 'googlechat') ||
    mediaConfigured
  ) {
    throw new CoreError('public_url_required')
  }
  return undefined
}
