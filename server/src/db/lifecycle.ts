import type Database from 'better-sqlite3';

export type DatabaseMode = 'initialize' | 'existing-only';
const existing = new WeakSet<Database.Database>();
/** Only mark connections after the complete schema has passed read-only validation. */
export function markExistingDatabase(db: Database.Database) { existing.add(db); }
export function isExistingDatabase(db: Database.Database) { return existing.has(db); }
