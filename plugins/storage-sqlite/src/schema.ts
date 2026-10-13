import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  blob,
  unique
} from 'drizzle-orm/sqlite-core'
import { sql } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import type { SQLiteColumn } from 'drizzle-orm/sqlite-core'

/** Keep the queue predicate literal so SQLite can use its matching partial index. */
export const isBlockingDelivery = (status: SQLiteColumn): SQL<boolean> =>
  sql<boolean>`${status} in ('pending','unknown')`

export const conversations = sqliteTable('conversations', {
  id: text('id').primaryKey(),
  endpoint: text('endpoint').notNull(),
  active: integer('active').notNull(),
  record: text('record').notNull()
})

export const inbound = sqliteTable(
  'inbound',
  {
    id: text('id').primaryKey(),
    channel: text('channel').notNull(),
    account: text('account').notNull(),
    event: text('event').notNull(),
    endpoint: text('endpoint').notNull(),
    acceptedAt: integer('accepted_at').notNull(),
    status: text('status').notNull(),
    version: integer('version').notNull(),
    record: text('record').notNull()
  },
  (table) => [
    unique().on(table.channel, table.account, table.event),
    index('inbound_fifo').on(table.endpoint, table.acceptedAt, table.id)
  ]
)

export const outbound = sqliteTable(
  'outbound',
  {
    id: text('id').primaryKey(),
    channelId: text('channel_id')
      .notNull()
      .references(() => conversations.id),
    messageId: text('message_id').notNull(),
    digest: text('digest').notNull(),
    status: text('status').notNull(),
    version: integer('version').notNull(),
    record: text('record').notNull()
  },
  (table) => [
    unique().on(table.channelId, table.messageId),
    index('outbound_channel_order')
      .on(table.channelId)
      .where(isBlockingDelivery(table.status))
  ]
)

export const media = sqliteTable(
  'media',
  {
    id: text('id').primaryKey(),
    channelId: text('channel_id')
      .notNull()
      .references(() => conversations.id),
    reference: text('reference').notNull(),
    data: blob('data', { mode: 'buffer' }),
    digest: text('digest').notNull(),
    staged: integer('staged').notNull().default(0),
    createdAt: integer('created_at').notNull()
  },
  (table) => [index('media_channel').on(table.channelId)]
)

export const pluginState = sqliteTable(
  'plugin_state',
  {
    plugin: text('plugin').notNull(),
    owner: text('owner').notNull(),
    key: text('key').notNull(),
    version: integer('version').notNull(),
    expiresAt: integer('expires_at'),
    record: text('record').notNull()
  },
  (table) => [primaryKey({ columns: [table.plugin, table.owner, table.key] })]
)
