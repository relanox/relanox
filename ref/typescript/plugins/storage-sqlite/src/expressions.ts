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

/** Native string matching preserves Unicode prefixes and treats LIKE wildcards literally. */
export const keyStartsWith = (
  column: SQLiteColumn,
  prefix: string
): SQL<boolean> => sql<boolean>`instr(${column}, ${prefix}) = 1`

/** Staging quotas count bytes in SQLite blobs rather than JSON reference metadata. */
export const blobLength = (column: SQLiteColumn): SQL<number> =>
  sql<number>`length(${column})`
