import { sql } from 'drizzle-orm'
import {
  pgTable,
  text,
  boolean,
  integer,
  bigint,
  jsonb,
  customType,
  index,
  unique,
  primaryKey
} from 'drizzle-orm/pg-core'
import type {
  ConversationRecord,
  InboundRecord,
  OutboundRecord,
  MediaReference,
  StateEntry
} from '@relanox/sdk'

const orderedText = customType<{ data: string }>({
  dataType: () => 'text COLLATE "C"'
})

const bytea = customType<{ data: Buffer }>({ dataType: () => 'bytea' })

export const conversations = pgTable('conversations', {
  id: text().primaryKey(),
  endpoint: text().notNull(),
  active: boolean().notNull(),
  record: jsonb().$type<ConversationRecord>().notNull()
})

export const inbound = pgTable(
  'inbound',
  {
    id: orderedText().primaryKey(),
    channel: text().notNull(),
    account: text().notNull(),
    event: text().notNull(),
    finalDeliveryId: text('final_delivery_id'),
    endpoint: text().notNull(),
    acceptedAt: bigint('accepted_at', { mode: 'number' }).notNull(),
    status: text().notNull(),
    version: integer().notNull(),
    record: jsonb().$type<InboundRecord>().notNull()
  },
  (table) => [
    unique().on(table.channel, table.account, table.event),
    index('inbound_fifo')
      .on(table.endpoint, table.acceptedAt, table.id)
      .where(sql`${table.status}='due'`),
    index('inbound_due')
      .on(
        sql`((${table.record}#>>'{dispatch,dueAt}')::bigint)`,
        table.acceptedAt,
        table.id
      )
      .where(sql`${table.status}='due'`),
    index('inbound_lease')
      .on(sql`((${table.record}#>>'{dispatch,lease,expiresAt}')::bigint)`)
      .where(sql`${table.status}='due'`)
  ]
)

export const outbound = pgTable(
  'outbound',
  {
    id: orderedText().primaryKey(),
    sequence: bigint({ mode: 'number' }).generatedAlwaysAsIdentity().unique(),
    channelId: text('channel_id')
      .notNull()
      .references(() => conversations.id),
    messageId: text('message_id').notNull(),
    digest: text().notNull(),
    status: text().notNull(),
    version: integer().notNull(),
    record: jsonb().$type<OutboundRecord>().notNull()
  },
  (table) => [
    unique().on(table.channelId, table.messageId),
    index('outbound_channel_order')
      .on(table.channelId, table.sequence)
      .where(sql`${table.status} IN ('pending','unknown')`),
    index('outbound_due')
      .on(sql`((${table.record}->>'dueAt')::bigint)`, table.id)
      .where(sql`${table.status}='pending'`),
    index('outbound_lease')
      .on(sql`((${table.record}#>>'{lease,expiresAt}')::bigint)`)
      .where(sql`${table.status}='pending'`)
  ]
)

export const media = pgTable(
  'media',
  {
    id: text().primaryKey(),
    channelId: text('channel_id')
      .notNull()
      .references(() => conversations.id),
    reference: jsonb().$type<MediaReference>().notNull(),
    data: bytea(),
    digest: text().notNull(),
    staged: boolean().notNull().default(false),
    createdAt: bigint('created_at', { mode: 'number' }).notNull()
  },
  (table) => [index('media_channel').on(table.channelId)]
)

export const pluginState = pgTable(
  'plugin_state',
  {
    plugin: text().notNull(),
    owner: text().notNull(),
    key: orderedText().notNull(),
    version: integer().notNull(),
    expiresAt: bigint('expires_at', { mode: 'number' }),
    record: jsonb().$type<StateEntry | null>().notNull()
  },
  (table) => [primaryKey({ columns: [table.plugin, table.owner, table.key] })]
)

export const schema = { conversations, inbound, outbound, media, pluginState }
