import type { Json, EpochMs } from './values.js'
import type { MutationResult } from './messages.js'

export interface StateNamespace {
  readonly pluginId: string
  readonly ownerId: string
}

export interface StateEntry {
  readonly key: string
  readonly value: Json
  readonly version: number
  readonly expiresAt?: EpochMs
}

export interface StateStore {
  get(key: string): Promise<StateEntry | undefined>
  list(input: {
    readonly prefix?: string
    readonly expiresBefore?: EpochMs
    readonly limit: number
  }): Promise<readonly StateEntry[]>
  compareAndSet(input: {
    readonly key: string
    readonly expectedVersion: number | null
    readonly value: Json
    readonly expiresAt?: EpochMs
  }): Promise<MutationResult>
  delete(key: string, expectedVersion: number): Promise<MutationResult>
}
