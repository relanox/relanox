import { installPlugin } from './plugin-install.js'
import { Command } from 'commander'
import { z } from 'zod'
import {
  missingSecrets,
  probeManagement,
  readStatus,
  withStorage
} from './admin.js'
import { readConfig } from './config.js'
import type { AppConfig } from './config.js'
import { startRuntime, validateApp } from './runtime.js'
import { discoverConversations } from './discovery.js'

export function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}

const configOptions = z.object({ config: z.string().min(1) })

const numberOption = (
  min: number,
  max: number
): z.ZodPipe<
  z.ZodPipe<z.ZodString, z.ZodTransform<number, string>>,
  z.ZodNumber
> =>
  z
    .string()
    .regex(/^\d+$/u)
    .transform(Number)
    .pipe(z.number().int().min(min).max(max))

async function configFrom(command: Command): Promise<AppConfig> {
  const options = configOptions.parse(command.optsWithGlobals())
  return validateApp(await readConfig(options.config))
}

async function run(command: Command): Promise<void> {
  const config = await configFrom(command)
  let requested = false

  let signalShutdown = (): void => {
    requested = true
  }

  const onSignal = (): void => {
    signalShutdown()
  }

  process.on('SIGINT', onSignal)
  process.on('SIGTERM', onSignal)
  try {
    const runtime = await startRuntime(config)
    printJson({
      ok: true,
      event: 'started',
      businessUrl: runtime.businessUrl,
      managementUrl: runtime.managementUrl
    })
    await new Promise<void>((resolve) => {
      signalShutdown = resolve
      if (requested) {
        resolve()
      }
    })
    await runtime.stop()
    printJson({ ok: true, event: 'stopped' })
  } finally {
    process.removeListener('SIGINT', onSignal)
    process.removeListener('SIGTERM', onSignal)
  }
}

function addStatus(program: Command): void {
  program
    .command('status')
    .description(
      'Show message and delivery status; use --include-content to show text'
    )
    .option('--limit <number>', 'Maximum records to show', '100')
    .option('--after-id <id>', 'Show records after this ID')
    .option('--endpoint-id <id>', 'Show records for this Agent')
    .option('--dispatch-status <status>', 'due, accepted, rejected, unknown')
    .option('--delivery-status <status>', 'pending, sent, rejected, unknown')
    .option(
      '--include-content',
      'Include inbound and outbound message text',
      false
    )
    .action(async (_options: unknown, command: Command) => {
      const config = await configFrom(command)

      const options = z
        .object({
          limit: numberOption(1, 1000),
          afterId: z.string().optional(),
          endpointId: z.string().optional(),
          dispatchStatus: z
            .enum(['due', 'accepted', 'rejected', 'unknown'])
            .optional(),
          deliveryStatus: z
            .enum(['pending', 'sent', 'rejected', 'unknown'])
            .optional(),
          includeContent: z.boolean()
        })
        .parse(command.opts())

      const filter = {
        limit: options.limit,
        ...(options.afterId === undefined ? {} : { afterId: options.afterId }),
        ...(options.endpointId === undefined
          ? {}
          : { endpointId: options.endpointId }),
        ...(options.dispatchStatus === undefined
          ? {}
          : { dispatchStatus: options.dispatchStatus }),
        ...(options.deliveryStatus === undefined
          ? {}
          : { deliveryStatus: options.deliveryStatus })
      }

      printJson(
        await withStorage(config, async (storage) =>
          readStatus(storage, filter, options.includeContent)
        )
      )
    })
}

function addRecovery(program: Command): void {
  program
    .command('requeue')
    .description(
      'Retry a saved notification or reply; uncertain results may cause duplicates'
    )
    .requiredOption('--kind <kind>', 'request or delivery')
    .requiredOption('--id <id>', 'Record ID')
    .requiredOption(
      '--expected-version <number>',
      'Current version shown by status'
    )
    .option(
      '--acknowledge-unknown',
      'Allow a retry that may repeat Agent work or send a duplicate reply',
      false
    )
    .action(async (_options: unknown, command: Command) => {
      const config = await configFrom(command)

      const options = z
        .object({
          kind: z.enum(['request', 'delivery']),
          id: z.string().min(1).max(1024),
          expectedVersion: numberOption(1, Number.MAX_SAFE_INTEGER),
          acknowledgeUnknown: z.boolean()
        })
        .parse(command.opts())

      const result = await withStorage(config, async (storage) =>
        storage.requeue({ ...options, now: Date.now() })
      )

      printJson(result)
      if (result.status !== 'updated') {
        process.exitCode = 2
      }
    })
  program
    .command('cleanup')
    .description(
      'Remove eligible completed message content and old attachments'
    )
    .requiredOption(
      '--before <epoch-ms>',
      'Clean content older than this Unix timestamp in milliseconds'
    )
    .option('--limit <number>', 'Maximum records', '100')
    .action(async (_options: unknown, command: Command) => {
      const config = await configFrom(command)

      const input = z
        .object({
          before: numberOption(0, Number.MAX_SAFE_INTEGER),
          limit: numberOption(1, 1000)
        })
        .parse(command.opts())

      printJson(
        await withStorage(config, async (storage) => storage.cleanup(input))
      )
    })
}

function addDiscovery(program: Command): void {
  program
    .command('discover')
    .description('Find WeCom chat IDs without forwarding messages to an Agent')
    .requiredOption('--account <id>', 'WeCom account ID from relay.accounts')
    .option(
      '--timeout <seconds>',
      'Stop discovery after this many seconds (1–600)',
      '120'
    )
    .action(async (_options: unknown, command: Command) => {
      const options = z
        .object({
          config: z.string().min(1),
          account: z.string().min(1),
          timeout: numberOption(1, 600)
        })
        .parse(command.optsWithGlobals())

      const controller = new AbortController()

      const stop = (): void => {
        controller.abort()
      }

      process.on('SIGINT', stop)
      process.on('SIGTERM', stop)
      try {
        await discoverConversations({
          configPath: options.config,
          accountId: options.account,
          timeoutSeconds: options.timeout,
          signal: controller.signal,
          output: printJson
        })
      } finally {
        process.removeListener('SIGINT', stop)
        process.removeListener('SIGTERM', stop)
      }
    })
}

export function createProgram(): Command {
  const program = new Command()
    .name('relanox')
    .version('0.1.0')
    .description('Connect chat apps to dot or Grok Bot')
    .requiredOption('-c, --config <path>', 'JSON configuration path')
    .exitOverride()
    .configureOutput({ writeErr() {} })

  program
    .command('validate')
    .description(
      'Check configuration without connecting to accounts or storage'
    )
    .action(async (_options: unknown, command: Command) => {
      const config = await configFrom(command)
      printJson({
        ok: true,
        accounts: config.relay.accounts.length,
        endpoints: config.relay.endpoints.length
      })
    })
  program
    .command('run')
    .description('Start Relanox and process messages')
    .action(async (_options: unknown, command: Command) => run(command))
  program
    .command('doctor')
    .description(
      'Check the database and required credentials without starting the service'
    )
    .option(
      '--management-url <url>',
      'Local management address of the running service'
    )
    .action(async (_options: unknown, command: Command) => {
      const config = await configFrom(command)

      const options = z
        .object({ managementUrl: z.url().optional() })
        .parse(command.opts())

      const health = await withStorage(config, async (storage) =>
        storage.health()
      )

      const missing = missingSecrets(config)

      const running =
        options.managementUrl === undefined
          ? undefined
          : await probeManagement(
              options.managementUrl,
              config.server.startupTimeoutMs
            )

      const ok = health.ok && missing.length === 0 && (running?.ready ?? true)
      printJson({
        ok,
        storage: { ok: health.ok },
        missingSecrets: missing,
        running,
        connections:
          'Check the running service metrics for account connections; doctor does not connect to chat platforms'
      })
      if (!ok) {
        process.exitCode = 2
      }
    })
  program
    .command('plugins')
    .description('Manage independently installed native plugins')
    .command('install <spec>')
    .description(
      'Install an exact npm version or a local .tgz without lifecycle scripts'
    )
    .action(async (spec: string, _options: unknown, command: Command) => {
      const options = configOptions.parse(command.optsWithGlobals())
      printJson({ ok: true, ...(await installPlugin(options.config, spec)) })
    })
  addStatus(program)
  addRecovery(program)
  addDiscovery(program)
  return program
}
