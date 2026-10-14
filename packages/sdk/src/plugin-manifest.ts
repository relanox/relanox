/** Native package metadata inspected before the runtime entrypoint is imported. */
export type PluginManifest = {
  readonly kind:
    'channel' | 'agent' | 'storage' | 'observability' | 'middleware'
  readonly id: string
  readonly sdkMajor: 1
  /** Package-relative compiled ESM entry exporting createPlugin(). */
  readonly entry: string
}
