import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type Database from 'better-sqlite3'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { app } from 'electron'

const MIGRATIONS_RELATIVE_PATH = 'resources/drizzle'
const MIGRATIONS_TABLE = '__drizzle_migrations'
const LEGACY_MIGRATIONS = [
  {
    createdAt: 1_763_176_841_336,
    hash: '20c544c34667576d75c3c377d9f10aeaa281eba2892a91b32c7d6b32fbeb33d3',
    isApplied: (sqlite: Database.Database): boolean =>
      hasTable(sqlite, 'download_history') &&
      hasTable(sqlite, 'subscription_items') &&
      hasTable(sqlite, 'subscriptions') &&
      hasIndex(sqlite, 'subscription_items_subscription_idx')
  },
  {
    createdAt: 1_768_961_568_903,
    hash: '820a72164d76d265455f1a8642e27af0beaae03b2878df2726bfcc3f3105ca04',
    isApplied: (sqlite: Database.Database): boolean =>
      hasColumn(sqlite, 'download_history', 'yt_dlp_command')
  },
  {
    createdAt: 1_768_961_585_359,
    hash: 'b52ea0e29bd5d00f68db555d33153432c66dbd286c0594e85d40b20094e941e8',
    isApplied: (sqlite: Database.Database): boolean =>
      hasColumn(sqlite, 'download_history', 'yt_dlp_log')
  }
] as const

/**
 * Check whether a SQLite table already exists.
 *
 * @param sqlite The raw SQLite connection.
 * @param tableName The table name to look up.
 * @returns True when the table exists.
 */
const hasTable = (sqlite: Database.Database, tableName: string): boolean =>
  Boolean(
    sqlite
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1")
      .get(tableName)
  )

/**
 * Check whether a SQLite index already exists.
 *
 * @param sqlite The raw SQLite connection.
 * @param indexName The index name to look up.
 * @returns True when the index exists.
 */
const hasIndex = (sqlite: Database.Database, indexName: string): boolean =>
  Boolean(
    sqlite
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ? LIMIT 1")
      .get(indexName)
  )

/**
 * Check whether a table already contains a specific column.
 *
 * @param sqlite The raw SQLite connection.
 * @param tableName The table to inspect.
 * @param columnName The target column name.
 * @returns True when the column exists.
 */
const hasColumn = (sqlite: Database.Database, tableName: string, columnName: string): boolean => {
  if (!hasTable(sqlite, tableName)) {
    return false
  }

  const columns = sqlite.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{
    name?: string
  }>
  return columns.some((column) => column.name === columnName)
}

/**
 * Read the underlying better-sqlite3 connection from a Drizzle database.
 *
 * @param database The Drizzle database wrapper.
 * @returns The raw SQLite connection.
 */
const getSqliteConnection = (database: BetterSQLite3Database): Database.Database =>
  (database as BetterSQLite3Database & { $client: Database.Database }).$client

/**
 * Backfill missing Drizzle migration rows for legacy databases that already match the schema.
 *
 * @param sqlite The raw SQLite connection.
 */
export const reconcileLegacyMigrationState = (sqlite: Database.Database): void => {
  sqlite.exec(
    `CREATE TABLE IF NOT EXISTS "${MIGRATIONS_TABLE}" (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric)`
  )

  const appliedHashes = new Set<string>(
    (
      sqlite.prepare(`SELECT hash FROM "${MIGRATIONS_TABLE}"`).all() as Array<{
        hash: string
      }>
    ).map((row) => row.hash)
  )
  const insertMigration = sqlite.prepare(
    `INSERT INTO "${MIGRATIONS_TABLE}" (hash, created_at) VALUES (?, ?)`
  )

  for (const migration of LEGACY_MIGRATIONS) {
    if (!(migration.isApplied(sqlite) && !appliedHashes.has(migration.hash))) {
      continue
    }

    insertMigration.run(migration.hash, migration.createdAt)
    appliedHashes.add(migration.hash)
  }
}

export const runMigrations = (database: BetterSQLite3Database): void => {
  const migrationsFolder = resolveMigrationsFolder()
  if (!migrationsFolder) {
    throw new Error('drizzle migrations folder not found for desktop')
  }

  reconcileLegacyMigrationState(getSqliteConnection(database))
  migrate(database, { migrationsFolder, migrationsTable: MIGRATIONS_TABLE })
}

const resolveMigrationsFolder = (): string | null => {
  const candidates = new Set<string>()
  candidates.add(resolve(process.cwd(), MIGRATIONS_RELATIVE_PATH))
  candidates.add(resolve(import.meta.dirname, '../../../../', MIGRATIONS_RELATIVE_PATH))

  if (process.resourcesPath) {
    candidates.add(join(process.resourcesPath, MIGRATIONS_RELATIVE_PATH))
    candidates.add(join(process.resourcesPath, 'app.asar.unpacked', MIGRATIONS_RELATIVE_PATH))
  }

  try {
    candidates.add(join(app.getAppPath(), MIGRATIONS_RELATIVE_PATH))
  } catch {
    // app might not be ready yet, ignore
  }

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate
    }
  }

  return null
}
