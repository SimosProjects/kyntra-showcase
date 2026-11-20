// Excerpt from the private Kyntra repository.
// Copyright (c) Meridion Systems. All rights reserved.
import { drizzle } from 'drizzle-orm/expo-sqlite';
import { openDatabaseSync } from 'expo-sqlite';

import { DATABASE_NAME } from './databaseName';
import * as schema from './schema';
import type { Db } from './types';

export function openDatabase(): Db {
  // A connection of its own. Without this, expo-sqlite returns the native database already open under the same name,
  // and two JavaScript objects then share a handle that either one closes when it is released (see init.ts).
  const sqlite = openDatabaseSync(DATABASE_NAME, { useNewConnection: true });
  // WAL keeps single-row writes fast. Foreign keys are off by default in SQLite.
  sqlite.execSync('PRAGMA journal_mode = WAL;');
  sqlite.execSync('PRAGMA foreign_keys = ON;');
  return drizzle(sqlite, { schema });
}
