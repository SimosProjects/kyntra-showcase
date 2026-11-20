// Excerpt from the private Kyntra repository.
// Copyright (c) Meridion Systems. All rights reserved.
import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/expo-sqlite/migrator';

import migrations from '../../drizzle/migrations';
import { clearLeftoversOnFreshInstall } from '../startup/freshInstall';
import { seedCatalog } from './catalog/seed';
import { openDatabase } from './client';
import { createRepositories, type Repositories } from './repositories';
import type { Db } from './types';

export type InitDeps = {
  open: () => Db;
  beforeOpen: () => Promise<unknown>;
};

const appDeps: InitDeps = { open: openDatabase, beforeOpen: clearLeftoversOnFreshInstall };

type Opened = { db: Db; repositories: Repositories };

// One connection for the life of the JavaScript runtime, not one per mount. Android recreates the app's screen on
// some setting changes, and React Native then mounts the whole app again in the same runtime. A second open there
// gave expo-sqlite's cached native database a second JavaScript object; when the first one was garbage collected, its
// release closed the native handle both used, and every later call failed (docs/adr/0055-one-database-connection.md).
let current: Promise<Opened> | null = null;

// Opens the database, applies migrations and seeds the catalog. Everything is local, so this never touches the
// network. The first launch seeds the catalog once; later launches only compare the stored catalog version.
async function openFresh(deps: InitDeps): Promise<Opened> {
  await deps.beforeOpen();
  const db = deps.open();
  // The migrator only needs the dialect and session, which every Drizzle SQLite db has.
  await migrate(db as never, migrations);
  seedCatalog(db);
  return { db, repositories: createRepositories(db) };
}

function isAlive(db: Db): boolean {
  try {
    db.get(sql`SELECT 1`);
    return true;
  } catch {
    return false;
  }
}

// The repositories on the runtime's one connection. A later mount reuses it after a quick check. If the check fails
// (or the last open failed), it opens a new connection, so the error screen's Try again recovers without closing the
// app. Nothing is lost: every change is written to SQLite when it is made.
export async function initRepositories(deps: InitDeps = appDeps): Promise<Repositories> {
  const previous = current;
  if (previous) {
    const opened = await previous.catch(() => null);
    if (opened && isAlive(opened.db)) return opened.repositories;
    // Another mount may have started a new open already.
    if (current === previous) current = null;
  }
  current ??= openFresh(deps);
  return (await current).repositories;
}

/** Forgets the connection, for tests that start the app again as a new runtime would. */
export function resetConnectionForTests() {
  current = null;
}
