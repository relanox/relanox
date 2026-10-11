#!/usr/bin/env node
import { CommanderError } from 'commander'
import { CoreError } from '@relanox/core'
import { PublicUrlError } from '@relanox/sdk'
import { createProgram } from './commands.js'

try {
  await createProgram().parseAsync(process.argv)
} catch (error) {
  if (error instanceof CommanderError && error.exitCode === 0) {
    process.exitCode = 0
  } else {
    const errorCode =
      error instanceof PublicUrlError ||
      (error instanceof CoreError && error.code === 'public_url_required')
        ? error.code
        : 'command_failed'

    // Validators, providers, and drivers may include credentials or body text in errors.
    process.stderr.write(`${JSON.stringify({ ok: false, errorCode })}\n`)
    process.exitCode = 1
  }
}
