#!/usr/bin/env node
import { CommanderError } from 'commander'
import { createProgram } from './commands.js'

try {
  await createProgram().parseAsync(process.argv)
} catch (error) {
  if (error instanceof CommanderError && error.exitCode === 0) {
    process.exitCode = 0
  } else {
    // Validators, providers, and drivers may include credentials or body text in errors.
    process.stderr.write(
      `${JSON.stringify({ ok: false, errorCode: 'command_failed' })}\n`
    )
    process.exitCode = 1
  }
}
