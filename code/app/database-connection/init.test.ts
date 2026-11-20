// Excerpt from the private Kyntra repository.
// Copyright (c) Meridion Systems. All rights reserved.
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { initRepositories, resetConnectionForTests, type InitDeps } from './init';
import * as schema from './schema';
import type { Db } from './types';

// jest.setup.js replaces init for every other test. These test the real one, on better-sqlite3 instead of expo-sqlite.
jest.unmock('./init');
jest.mock('./client', () => ({ openDatabase: jest.fn() }));
jest.mock('../startup/freshInstall', () => ({ clearLeftoversOnFreshInstall: jest.fn() }));

// A database file opened the way the app opens its own: each open is a new connection to the same file.
function fileDeps(path: string) {
  const connections: Database.Database[] = [];
  const deps: InitDeps = {
    beforeOpen: jest.fn(async () => undefined),
    open: jest.fn(() => {
      const sqlite = new Database(path);
      sqlite.pragma('journal_mode = WAL');
      sqlite.pragma('foreign_keys = ON');
      connections.push(sqlite);
      return drizzle(sqlite, { schema }) as unknown as Db;
    }),
  };
  return { deps, connections };
}

let dir: string;
beforeEach(() => {
  resetConnectionForTests();
  dir = mkdtempSync(join(tmpdir(), 'kyntra-init-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('initRepositories', () => {
  it('opens the database once, however many times the app is mounted', async () => {
    const { deps } = fileDeps(join(dir, 'kyntra.db'));

    const first = await initRepositories(deps);
    const second = await initRepositories(deps);
    const third = await initRepositories(deps);

    expect(deps.open).toHaveBeenCalledTimes(1);
    expect(deps.beforeOpen).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
    expect(third).toBe(first);
  });

  it('shares one open between mounts that start at the same time', async () => {
    const { deps } = fileDeps(join(dir, 'kyntra.db'));

    const [a, b] = await Promise.all([initRepositories(deps), initRepositories(deps)]);

    expect(deps.open).toHaveBeenCalledTimes(1);
    expect(b).toBe(a);
  });

  it('opens a new connection when the one it has no longer answers, and keeps what was saved', async () => {
    const { deps, connections } = fileDeps(join(dir, 'kyntra.db'));
    const first = await initRepositories(deps);
    const workout = first.workouts.start({ timeZone: 'UTC' });
    // The native handle is gone, as when Android recreated the screen on the Galaxy.
    connections[0]!.close();
    expect(() => first.workouts.getActive()).toThrow();

    const [second, third] = await Promise.all([initRepositories(deps), initRepositories(deps)]);

    expect(deps.open).toHaveBeenCalledTimes(2);
    expect(second).not.toBe(first);
    expect(third).toBe(second);
    expect(second.workouts.getActive()?.id).toBe(workout.id);
  });

  it('tries the open again after a failed one', async () => {
    const { deps } = fileDeps(join(dir, 'kyntra.db'));
    jest.mocked(deps.open).mockImplementationOnce(() => {
      throw new Error('disk I/O error');
    });

    await expect(initRepositories(deps)).rejects.toThrow('disk I/O error');
    const repositories = await initRepositories(deps);

    expect(deps.open).toHaveBeenCalledTimes(2);
    expect(repositories.workouts.getActive()).toBeUndefined();
  });
});
