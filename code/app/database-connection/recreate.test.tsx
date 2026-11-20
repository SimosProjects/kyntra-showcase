// Excerpt from the private Kyntra repository.
// Copyright (c) Meridion Systems. All rights reserved.
import { fireEvent, render, screen } from '@testing-library/react-native';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { useState } from 'react';
import { Pressable, Text } from 'react-native';

import { ErrorBoundary } from '../errors/ErrorBoundary';
import { i18n } from '../i18n';
import { useWorkoutStore, WorkoutStoreProvider } from '../workout/hooks';
import { WorkoutStore } from '../workout/store';
import { DatabaseProvider, useRepositories } from './DatabaseProvider';
import { initRepositories, resetConnectionForTests, type InitDeps } from './init';
import * as schema from './schema';
import type { Db } from './types';

// jest.setup.js replaces init for every other test. These test the real one, on better-sqlite3 instead of expo-sqlite.
jest.unmock('./init');
jest.mock('./client', () => ({ openDatabase: jest.fn() }));
jest.mock('../startup/freshInstall', () => ({ clearLeftoversOnFreshInstall: jest.fn() }));

jest.mock('../errors/errorReports', () => ({
  reportRenderError: jest.fn(),
  reportSetRefused: jest.fn(),
}));
jest.mock('../startup/splash', () => ({ hideSplash: jest.fn() }));

// When Android recreates MainActivity (a font size change, for one), React Native mounts the whole app again in the
// same JavaScript runtime. These tests unmount and mount the app's tree the same way, on a database file.

let dir: string;
let connections: Database.Database[];
let deps: InitDeps;

beforeEach(() => {
  resetConnectionForTests();
  dir = mkdtempSync(join(tmpdir(), 'kyntra-recreate-'));
  connections = [];
  deps = {
    beforeOpen: async () => undefined,
    open: jest.fn(() => {
      const sqlite = new Database(join(dir, 'kyntra.db'));
      sqlite.pragma('journal_mode = WAL');
      sqlite.pragma('foreign_keys = ON');
      connections.push(sqlite);
      return drizzle(sqlite, { schema }) as unknown as Db;
    }),
  };
});
afterEach(async () => {
  for (const sqlite of connections) if (sqlite.open) sqlite.close();
  rmSync(dir, { recursive: true, force: true });
  await i18n.changeLanguage('en');
});

// Reads the database while drawing, as the app's screens do, so a dead connection fails the render.
function Probe() {
  const repos = useRepositories();
  const store = useWorkoutStore();
  const [, redraw] = useState(0);
  const active = repos.workouts.getActive();
  const sets = store.getRows().filter((row) => row.type === 'set').length;
  return (
    <Pressable accessibilityRole="button" onPress={() => redraw((n) => n + 1)}>
      <Text>{active ? `In progress, ${sets} sets` : 'No workout'}</Text>
    </Pressable>
  );
}

function app() {
  return (
    <ErrorBoundary>
      <DatabaseProvider init={() => initRepositories(deps)}>
        <WorkoutStoreProvider>
          <Probe />
        </WorkoutStoreProvider>
      </DatabaseProvider>
    </ErrorBoundary>
  );
}

// The person logs two sets on the app's one connection, then Android recreates the screen.
async function logTwoSets() {
  const store = new WorkoutStore(await initRepositories(deps), {
    defaultUnit: () => 'kg',
    timeZone: () => 'UTC',
    locale: () => 'en-US',
  });
  store.start();
  const bench = store.addExercise('barbell-bench-press');
  store.addSet(bench, { weight: { value: 60, unit: 'kg' }, reps: 8 });
  store.addSet(bench, { weight: { value: 135, unit: 'lb' }, reps: 5 });
  store.dispose();
}

describe('the app mounted again in the same runtime', () => {
  it('keeps the workout in progress and opens the database once', async () => {
    await logTwoSets();

    const view = await render(app());
    expect(await screen.findByText('In progress, 2 sets')).toBeTruthy();
    await view.unmount();
    await render(app());
    expect(await screen.findByText('In progress, 2 sets')).toBeTruthy();

    expect(deps.open).toHaveBeenCalledTimes(1);
  });

  it('recovers on Try again when the connection died, with the workout intact', async () => {
    const errors = jest.spyOn(console, 'error').mockImplementation(() => {});
    await logTwoSets();
    await render(app());
    expect(await screen.findByText('In progress, 2 sets')).toBeTruthy();

    connections[0]!.close();
    await fireEvent.press(screen.getByRole('button'));
    expect(await screen.findByText('Something went wrong')).toBeTruthy();

    await fireEvent.press(screen.getByRole('button', { name: 'Try again' }));

    expect(await screen.findByText('In progress, 2 sets')).toBeTruthy();
    expect(deps.open).toHaveBeenCalledTimes(2);
    errors.mockRestore();
  });
});
