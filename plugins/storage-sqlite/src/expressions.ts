import { sql } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import type { SQLiteColumn, SQLiteTable } from 'drizzle-orm/sqlite-core'

/** SQLite exposes insertion order through its implicit rowid, which legacy queues use. */
export const rowId = (table: SQLiteTable): SQL<number> =>
  sql<number>`${table}.rowid`

/** JSON paths are bound values; durable records retain their existing text representation. */
export const jsonValue = <T = string>(
  column: SQLiteColumn,
  path: string
): SQL<T> => sql<T>`json_extract(${column}, ${path})`

/** Prefix matching must treat %, _ and backslashes literally, unlike LIKE. */
export const keyPrefix = (column: SQLiteColumn, length: number): SQL<string> =>
  sql<string>`substr(${column}, 1, ${length})`

/** Staging quotas count bytes in SQLite blobs rather than JSON reference metadata. */
export const blobLength = (column: SQLiteColumn): SQL<number> =>
  sql<number>`length(${column})`
