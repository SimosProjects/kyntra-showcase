// Excerpt from the private Kyntra repository.
// Copyright (c) Meridion Systems. All rights reserved.
import { eq } from 'drizzle-orm';

import { fakeTokens } from '../auth/test-helpers';
import { decideIncoming } from '../db/repositories/sync';
import { preference, workout, workoutExercise, workoutSet } from '../db/schema';
import { DAY_MS, finishedWorkout, MONDAY } from '../workout/test-data';
import { SyncEngine } from './engine';
import { createDevice, type Device } from './test-device';
import { FakeSyncServer } from './test-server';

const ALICE = '0198a000-0000-7000-8000-00000000000a';
const SERVER_NOW = MONDAY + 30 * DAY_MS;

const newServer = () => new FakeSyncServer(() => SERVER_NOW);

const oneWorkout = (d: Device, at = MONDAY, sets = 2) =>
  finishedWorkout(d.repos, d.clock, {
    at,
    exercises: [
      {
        id: 'leg-press',
        sets: Array.from({ length: sets }, (_, i) => ({ kg: 100 + i, reps: 10 })),
      },
    ],
  });

const dirtyCount = (d: Device) => d.repos.sync.pending().count;
const allWorkouts = (d: Device) => d.db.select().from(workout).all();
const allSets = (d: Device) => d.db.select().from(workoutSet).all();

describe('pushing', () => {
  it('sends unsynced rows parents first and oldest first, in batches of at most 200, and clears them', async () => {
    const server = newServer();
    const d = await createDevice(server, { name: 'a', accountId: ALICE });
    // 10 workouts, each with one exercise and 40 sets: 420 rows, so three or more pushes.
    for (let i = 0; i < 10; i++) {
      finishedWorkout(d.repos, d.clock, {
        at: MONDAY + i * DAY_MS,
        exercises: [
          { id: 'leg-press', sets: Array.from({ length: 40 }, () => ({ kg: 50, reps: 5 })) },
        ],
      });
    }
    d.repos.preferences.set('default_unit', 'kg');
    expect(dirtyCount(d)).toBe(421);

    await d.engine.run('manual');

    expect(dirtyCount(d)).toBe(0);
    expect(server.pushes.length).toBeGreaterThanOrEqual(3);
    const seen = new Set<string>();
    let lastWorkoutTime = 0;
    for (const { request } of server.pushes) {
      const size =
        (request.workouts?.length ?? 0) +
        (request.workoutExercises?.length ?? 0) +
        (request.workoutSets?.length ?? 0) +
        (request.preferences?.length ?? 0);
      expect(size).toBeLessThanOrEqual(200);
      for (const w of request.workouts ?? []) {
        seen.add(w.id);
        const time = Date.parse(w.updatedAt);
        expect(time).toBeGreaterThanOrEqual(lastWorkoutTime);
        lastWorkoutTime = time;
      }
      for (const e of request.workoutExercises ?? []) {
        expect(seen.has(e.workoutId)).toBe(true); // its workout was sent before or with it
        seen.add(e.id);
      }
      for (const s of request.workoutSets ?? []) expect(seen.has(s.workoutExerciseId)).toBe(true);
    }
    expect(server.stored(ALICE, 'workouts')).toHaveLength(10);
    expect(server.stored(ALICE, 'workoutSets')).toHaveLength(400);
    expect(server.stored(ALICE, 'preferences')).toHaveLength(1);
  });

  it('sends the typed weight and unit exactly and the kilograms beside them', async () => {
    const server = newServer();
    const d = await createDevice(server, { name: 'a', accountId: ALICE });
    finishedWorkout(d.repos, d.clock, {
      at: MONDAY,
      exercises: [
        {
          id: 'cable-crossover',
          sets: [
            { lb: 40, reps: 12 },
            { kg: 52.5, reps: 8 },
          ],
        },
      ],
    });

    await d.engine.run('manual');

    const sets = server.stored(ALICE, 'workoutSets');
    expect(sets.map((s) => [s.weightValue, s.weightUnit])).toEqual([
      [40, 'lb'],
      [52.5, 'kg'],
    ]);
    expect(Number(sets[0]!.weightKg)).toBeCloseTo(18.1437, 3);
  });

  it('keeps a row marked unsynced when it changed while its push was in flight, and sends it next', async () => {
    const server = newServer();
    const d = await createDevice(server, { name: 'a', accountId: ALICE });
    const { exercises } = oneWorkout(d, MONDAY, 1);
    const setId = exercises[0]!.sets[0]!.id;
    let edited = false;
    server.afterApply = () => {
      if (edited) return;
      edited = true;
      d.repos.sets.update(setId, { reps: 99 }); // the user edits while the push is in flight
    };

    await d.engine.run('manual');

    expect(server.pushes.length).toBe(2);
    expect(server.stored(ALICE, 'workoutSets')[0]!.reps).toBe(99);
    expect(dirtyCount(d)).toBe(0);
    expect(server.version(ALICE, 'workoutSets', setId)).toBe(2);
  });

  it('leaves a row unsynced if the edit lands after the answer but before it is marked', async () => {
    const server = newServer();
    const d = await createDevice(server, { name: 'a', accountId: ALICE });
    const { exercises } = oneWorkout(d, MONDAY, 1);
    const setId = exercises[0]!.sets[0]!.id;
    const batch = d.repos.sync.nextBatch(200);
    const stale = batch.find((i) => i.table === 'workoutSet')!;

    d.repos.sets.update(setId, { reps: 7 });
    d.repos.sync.markPushed([{ table: stale.table, key: stale.key, rev: stale.rev }]);

    expect(d.repos.sync.isStillDirty({ table: 'workoutSet', key: setId, rev: stale.rev + 1 })).toBe(
      true,
    );
    expect(d.db.select().from(workoutSet).where(eq(workoutSet.id, setId)).get()?.dirty).toBe(true);
  });

  it('creates no duplicates when the same rows are sent three times', async () => {
    const server = newServer();
    const d = await createDevice(server, { name: 'a', accountId: ALICE });
    oneWorkout(d);

    await d.engine.run('manual');
    for (let i = 0; i < 3; i++) {
      for (const table of [workout, workoutExercise, workoutSet, preference])
        d.db.update(table).set({ dirty: true }).run();
      await d.engine.run('manual');
    }

    expect(server.stored(ALICE, 'workouts')).toHaveLength(1);
    expect(server.stored(ALICE, 'workoutExercises')).toHaveLength(1);
    expect(server.stored(ALICE, 'workoutSets')).toHaveLength(2);
    // The replays were answered unchanged, so the server did not write them again.
    const last = server.pushes.at(-1)!;
    expect(server.version(ALICE, 'workouts', last.request.workouts![0]!.id)).toBe(1);
    expect(dirtyCount(d)).toBe(0);
  });

  it('sends the rows again when the answer was lost and ends with one copy', async () => {
    const server = newServer();
    const d = await createDevice(server, { name: 'a', accountId: ALICE });
    oneWorkout(d);
    server.loseNextResponses = 1;

    await d.engine.run('manual');
    expect(d.engine.getStatus().lastFailure).toBe('offline');
    expect(dirtyCount(d)).toBeGreaterThan(0);

    await d.engine.run('manual');

    expect(dirtyCount(d)).toBe(0);
    expect(server.stored(ALICE, 'workouts')).toHaveLength(1);
    expect(server.stored(ALICE, 'workoutSets')).toHaveLength(2);
    expect(d.engine.getStatus().lastFailure).toBeNull();
  });

  it('syncs days of offline work with the original times', async () => {
    const server = newServer();
    const d = await createDevice(server, { name: 'a', accountId: ALICE });
    server.offline = true;
    for (let day = 0; day < 3; day++) oneWorkout(d, MONDAY + day * DAY_MS);
    await d.engine.run('manual');
    expect(d.engine.getStatus().lastFailure).toBe('offline');
    expect(dirtyCount(d)).toBeGreaterThan(0);

    d.clock.set(MONDAY + 4 * DAY_MS);
    server.offline = false;
    await d.engine.run('reconnect');

    expect(dirtyCount(d)).toBe(0);
    const stored = server.stored(ALICE, 'workouts');
    expect(stored.map((w) => Date.parse(String(w.startedAt))).sort()).toEqual([
      MONDAY,
      MONDAY + DAY_MS,
      MONDAY + 2 * DAY_MS,
    ]);
  });

  it('syncs a workout that is still in progress and picks up later edits', async () => {
    const server = newServer();
    const d = await createDevice(server, { name: 'a', accountId: ALICE });
    const w = d.repos.workouts.start({ timeZone: 'UTC' });
    await d.engine.run('timer');
    expect(server.stored(ALICE, 'workouts')[0]!.endedAt).toBeNull();

    d.clock.advance(60_000);
    d.repos.workouts.complete(w.id);
    await d.engine.run('workoutCompleted');

    expect(server.stored(ALICE, 'workouts')[0]!.endedAt).not.toBeNull();
    expect(server.version(ALICE, 'workouts', w.id)).toBe(2);
  });

  it('syncs the still training setting like the unit', async () => {
    const server = newServer();
    const a = await createDevice(server, { name: 'a', accountId: ALICE });
    const b = await createDevice(server, { name: 'b', accountId: ALICE });
    a.repos.preferences.set('still_training_minutes', '30');

    await a.engine.run('manual');
    await b.engine.run('manual');

    expect(b.repos.preferences.get('still_training_minutes')).toBe('30');
    expect(dirtyCount(b)).toBe(0);
  });

  it('syncs paused time and an open pause to another device', async () => {
    const server = newServer();
    const a = await createDevice(server, { name: 'a', accountId: ALICE });
    const b = await createDevice(server, { name: 'b', accountId: ALICE });
    a.clock.set(MONDAY);
    const w = a.repos.workouts.start({ timeZone: 'UTC' });
    a.clock.set(MONDAY + 10 * 60_000);
    a.repos.workouts.pause(w.id);
    a.clock.set(MONDAY + 12 * 60_000);
    a.repos.workouts.endPause(w.id);
    a.clock.set(MONDAY + 20 * 60_000);
    a.repos.workouts.pause(w.id);

    await a.engine.run('manual');
    await b.engine.run('manual');

    expect(server.stored(ALICE, 'workouts')[0]).toMatchObject({
      pausedSeconds: 120,
      pausedAt: new Date(MONDAY + 20 * 60_000).toISOString(),
    });
    expect(b.repos.workouts.get(w.id)).toMatchObject({
      pausedSeconds: 120,
      pausedAt: MONDAY + 20 * 60_000,
    });
    expect(dirtyCount(b)).toBe(0);
  });

  it('syncs the end of a pause as an edit of the same workout', async () => {
    const server = newServer();
    const a = await createDevice(server, { name: 'a', accountId: ALICE });
    const b = await createDevice(server, { name: 'b', accountId: ALICE });
    a.clock.set(MONDAY);
    const w = a.repos.workouts.start({ timeZone: 'UTC' });
    a.repos.workouts.pause(w.id);
    await a.engine.run('manual');
    await b.engine.run('manual');
    expect(b.repos.workouts.get(w.id)?.pausedAt).not.toBeNull();

    a.clock.set(MONDAY + 5 * 60_000);
    a.repos.workouts.endPause(w.id);
    await a.engine.run('manual');
    await b.engine.run('manual');

    expect(b.repos.workouts.get(w.id)).toMatchObject({ pausedAt: null, pausedSeconds: 300 });
  });

  it('syncs preferences', async () => {
    const server = newServer();
    const a = await createDevice(server, { name: 'a', accountId: ALICE });
    const b = await createDevice(server, { name: 'b', accountId: ALICE });
    a.repos.preferences.set('default_unit', 'lb');

    await a.engine.run('manual');
    await b.engine.run('manual');

    expect(b.repos.preferences.get('default_unit')).toBe('lb');
    expect(dirtyCount(b)).toBe(0);
  });
});

describe('answers the server gives', () => {
  it('pulls straight after a stale answer and takes the server copy', async () => {
    const server = newServer();
    const a = await createDevice(server, { name: 'a', accountId: ALICE });
    const b = await createDevice(server, { name: 'b', accountId: ALICE });
    const { workout: w } = oneWorkout(a);
    await a.engine.run('manual');
    await b.engine.run('manual');

    // b edits later and syncs first. a edited earlier and syncs after: its edit is the older one.
    b.clock.set(MONDAY + 3 * 3_600_000);
    b.repos.workouts.setNotes(w.id, 'from b');
    a.clock.set(MONDAY + 2 * 3_600_000);
    a.repos.workouts.setNotes(w.id, 'from a');
    await b.engine.run('manual');
    server.pulls.length = 0;

    await a.engine.run('manual');

    expect(server.pushes.at(-1)!.request.workouts![0]!.id).toBe(w.id);
    expect(server.pulls.length).toBeGreaterThanOrEqual(1); // pulled right after the stale answer
    expect(a.repos.workouts.get(w.id)?.notes).toBe('from b');
    expect(dirtyCount(a)).toBe(0);
    expect(server.stored(ALICE, 'workouts')[0]!.notes).toBe('from b');
  });

  it('ends with the later edit when two devices edit the same set, whichever syncs first', async () => {
    for (const order of [
      ['a', 'b'],
      ['b', 'a'],
    ] as const) {
      const server = newServer();
      const devices = {
        a: await createDevice(server, { name: 'a', accountId: ALICE }),
        b: await createDevice(server, { name: 'b', accountId: ALICE }),
      };
      const { exercises } = oneWorkout(devices.a, MONDAY, 1);
      const setId = exercises[0]!.sets[0]!.id;
      await devices.a.engine.run('manual');
      await devices.b.engine.run('manual');

      devices.a.clock.set(MONDAY + 5 * 60_000);
      devices.a.repos.sets.update(setId, { reps: 11 });
      devices.b.clock.set(MONDAY + 10 * 60_000);
      devices.b.repos.sets.update(setId, { reps: 12 }); // the later edit
      for (const name of order) await devices[name].engine.run('manual');
      for (const name of order) await devices[name].engine.run('manual');

      expect(server.stored(ALICE, 'workoutSets')[0]!.reps).toBe(12);
      expect(
        devices.a.db.select().from(workoutSet).where(eq(workoutSet.id, setId)).get()?.reps,
      ).toBe(12);
      expect(
        devices.b.db.select().from(workoutSet).where(eq(workoutSet.id, setId)).get()?.reps,
      ).toBe(12);
      expect(dirtyCount(devices.a) + dirtyCount(devices.b)).toBe(0);
    }
  });

  it('lets a delete beat a later edit from another device, and both end deleted', async () => {
    const server = newServer();
    const a = await createDevice(server, { name: 'a', accountId: ALICE });
    const b = await createDevice(server, { name: 'b', accountId: ALICE });
    const { workout: w } = oneWorkout(a);
    await a.engine.run('manual');
    await b.engine.run('manual');

    a.clock.set(MONDAY + 2 * 3_600_000);
    a.repos.workouts.softDelete(w.id);
    b.clock.set(MONDAY + 3 * 3_600_000); // b edits later, still not knowing about the delete
    b.repos.workouts.setNotes(w.id, 'edited after the delete');
    await a.engine.run('manual');
    await b.engine.run('manual');

    expect(allWorkouts(b)[0]!.deletedAt).not.toBeNull();
    expect(allWorkouts(b)[0]!.notes).not.toBe('edited after the delete');
    expect(server.stored(ALICE, 'workouts')[0]!.deletedAt).not.toBeNull();
    expect(dirtyCount(b)).toBe(0);
    expect(b.repos.history.historyPage({ limit: 5 })).toHaveLength(0);
  });

  it('sends a delete and the other device removes the workout', async () => {
    const server = newServer();
    const a = await createDevice(server, { name: 'a', accountId: ALICE });
    const b = await createDevice(server, { name: 'b', accountId: ALICE });
    const { workout: w } = oneWorkout(a);
    await a.engine.run('manual');
    await b.engine.run('manual');
    expect(b.repos.history.historyPage({ limit: 5 })).toHaveLength(1);

    a.clock.advance(1000);
    a.repos.workouts.softDelete(w.id);
    await a.engine.run('manual');
    await b.engine.run('manual');

    expect(b.repos.history.historyPage({ limit: 5 })).toHaveLength(0);
    expect(allSets(b).every((s) => s.deletedAt !== null)).toBe(true);
  });

  it('does not take a refused row again until it is edited, and still syncs the others', async () => {
    const server = newServer();
    const d = await createDevice(server, { name: 'a', accountId: ALICE });
    const { exercises } = oneWorkout(d, MONDAY, 2);
    const bad = exercises[0]!.sets[0]!.id;
    // A value the server will not take: more than three decimals.
    d.db.update(workoutSet).set({ weightValue: 22.12345 }).where(eq(workoutSet.id, bad)).run();

    await d.engine.run('manual');

    expect(d.engine.getStatus().rejectedRows).toBe(1);
    expect(server.stored(ALICE, 'workoutSets')).toHaveLength(1);
    expect(dirtyCount(d)).toBe(1);

    const pushesBefore = server.pushes.length;
    await d.engine.run('manual');
    expect(server.pushes.length).toBe(pushesBefore); // not sent again

    // Editing the row changes its rev, so it is tried again.
    d.repos.sets.update(bad, { weight: { value: 22.1, unit: 'kg' } });
    await d.engine.run('manual');
    expect(server.stored(ALICE, 'workoutSets')).toHaveLength(2);
    expect(dirtyCount(d)).toBe(0);
  });

  it('does not loop on a tie the server keeps', async () => {
    const server = newServer();
    const a = await createDevice(server, { name: 'a', accountId: ALICE });
    const b = await createDevice(server, { name: 'b', accountId: ALICE });
    const { workout: w } = oneWorkout(a);
    await a.engine.run('manual');
    await b.engine.run('manual');
    // Both devices edit in the same millisecond.
    a.clock.set(MONDAY + 2 * 3_600_000);
    b.clock.set(MONDAY + 2 * 3_600_000);
    a.repos.workouts.setNotes(w.id, 'from a');
    b.repos.workouts.setNotes(w.id, 'from b');
    await a.engine.run('manual');
    server.pushes.length = 0;

    await b.engine.run('manual');

    expect(server.pushes.length).toBeLessThanOrEqual(2);
    expect(server.stored(ALICE, 'workouts')[0]!.notes).toBe('from a');
  });
});

describe('refused rows', () => {
  const reasonOf = (d: Device, id: string) =>
    d.db.select().from(workoutSet).where(eq(workoutSet.id, id)).get()?.rejectedReason;

  it('marks the refused row with the reason and leaves the others unmarked', async () => {
    const server = newServer();
    const d = await createDevice(server, { name: 'a', accountId: ALICE });
    const { exercises } = oneWorkout(d, MONDAY, 2);
    const bad = exercises[0]!.sets[0]!.id;
    const good = exercises[0]!.sets[1]!.id;
    d.db.update(workoutSet).set({ weightValue: 22.12345 }).where(eq(workoutSet.id, bad)).run();

    await d.engine.run('manual');

    expect(reasonOf(d, bad)).toBe('invalid_value');
    expect(reasonOf(d, good)).toBeNull();
    expect(d.db.select().from(workout).all()[0]!.rejectedReason).toBeNull();
    expect(dirtyCount(d)).toBe(1); // the refused row is still unsent
    expect(d.repos.sync.rejectedAmong([exercises[0]!.row.workoutId]).size).toBe(1);
  });

  it('keeps the note after a restart, because it is stored on the row', async () => {
    const server = newServer();
    const d = await createDevice(server, { name: 'a', accountId: ALICE });
    const { exercises } = oneWorkout(d, MONDAY, 1);
    const bad = exercises[0]!.sets[0]!.id;
    d.db.update(workoutSet).set({ weightValue: 1.00001 }).where(eq(workoutSet.id, bad)).run();
    await d.engine.run('manual');

    const restarted = new SyncEngine({
      repos: d.repos,
      api: d.session.api,
      auth: d.session.auth,
      yieldToUi: () => Promise.resolve(),
    });

    expect(restarted.getStatus().rejectedRows).toBe(0); // the engine forgets, the row does not
    expect(reasonOf(d, bad)).toBe('invalid_value');
  });

  it('clears the note when a later push of the row is accepted', async () => {
    const server = newServer();
    const d = await createDevice(server, { name: 'a', accountId: ALICE });
    const { exercises } = oneWorkout(d, MONDAY, 1);
    const bad = exercises[0]!.sets[0]!.id;
    d.db.update(workoutSet).set({ weightValue: 22.12345 }).where(eq(workoutSet.id, bad)).run();
    await d.engine.run('manual');
    expect(reasonOf(d, bad)).toBe('invalid_value');

    d.repos.sets.update(bad, { weight: { value: 22.1, unit: 'kg' } });
    expect(reasonOf(d, bad)).toBe('invalid_value'); // the edit alone does not clear it
    await d.engine.run('manual');

    expect(reasonOf(d, bad)).toBeNull();
    expect(dirtyCount(d)).toBe(0);
    expect(d.repos.sync.rejectedAmong([exercises[0]!.row.workoutId]).size).toBe(0);
  });

  it('clears the note when the server copy replaces the row', async () => {
    const server = newServer();
    const a = await createDevice(server, { name: 'a', accountId: ALICE });
    const b = await createDevice(server, { name: 'b', accountId: ALICE });
    const { exercises } = oneWorkout(a, MONDAY, 1);
    const setId = exercises[0]!.sets[0]!.id;
    await a.engine.run('manual');
    await b.engine.run('manual');
    b.db
      .update(workoutSet)
      .set({ rejectedReason: 'invalid_value', dirty: false })
      .where(eq(workoutSet.id, setId))
      .run();
    a.clock.set(MONDAY + 3_600_000);
    a.repos.sets.update(setId, { reps: 20 });
    await a.engine.run('manual');

    await b.engine.run('manual');

    expect(reasonOf(b, setId)).toBeNull();
    expect(b.db.select().from(workoutSet).where(eq(workoutSet.id, setId)).get()?.reps).toBe(20);
  });

  it('does not mark a row that was edited while the refused push was in flight', async () => {
    const server = newServer();
    const d = await createDevice(server, { name: 'a', accountId: ALICE });
    const { exercises } = oneWorkout(d, MONDAY, 1);
    const id = exercises[0]!.sets[0]!.id;
    const [sent] = d.repos.sync.nextBatch(200).filter((i) => i.table === 'workoutSet');
    d.repos.sets.update(id, { reps: 3 }); // a newer rev than the one that was sent

    d.repos.sync.markRejected([
      { table: 'workoutSet', key: id, rev: sent!.rev, reason: 'invalid_value' },
    ]);

    expect(reasonOf(d, id)).toBeNull();
  });
});

describe('pulling', () => {
  it('applies rows without marking them unsynced and remembers the cursor', async () => {
    const server = newServer();
    const a = await createDevice(server, { name: 'a', accountId: ALICE });
    const b = await createDevice(server, { name: 'b', accountId: ALICE });
    oneWorkout(a);
    oneWorkout(a, MONDAY + DAY_MS);
    await a.engine.run('manual');

    await b.engine.run('manual');

    expect(b.repos.history.historyPage({ limit: 5 })).toHaveLength(2);
    expect(dirtyCount(b)).toBe(0);
    expect(b.repos.account.hasUnsyncedData()).toBe(false);
    expect(b.repos.sync.getCursor()).toBeGreaterThan(0);
    // The typed unit survives the trip.
    expect(allSets(b).map((s) => s.weightUnit)).toEqual(['kg', 'kg', 'kg', 'kg']);
  });

  it('asks only for what is new after a restart', async () => {
    const server = newServer();
    const a = await createDevice(server, { name: 'a', accountId: ALICE });
    oneWorkout(a);
    await a.engine.run('manual');
    const cursor = a.repos.sync.getCursor();
    server.pulls.length = 0;

    // A new engine on the same database, as after the app restarts.
    const restarted = new SyncEngine({
      repos: a.repos,
      api: a.session.api,
      auth: a.session.auth,
      yieldToUi: () => Promise.resolve(),
    });
    await restarted.run('start');

    expect(server.pulls[0]!.since).toBe(cursor);
  });

  it('pages through a long history without gaps', async () => {
    const server = newServer();
    const a = await createDevice(server, { name: 'a', accountId: ALICE });
    const b = await createDevice(server, { name: 'b', accountId: ALICE, pullLimit: 7 });
    for (let i = 0; i < 6; i++) oneWorkout(a, MONDAY + i * DAY_MS, 3);
    await a.engine.run('manual');

    await b.engine.run('manual');

    expect(b.repos.history.historyPage({ limit: 10 })).toHaveLength(6);
    expect(allSets(b)).toHaveLength(18);
    expect(server.pulls.filter((p) => p.accountId === ALICE).length).toBeGreaterThan(3);
  });

  it('copes with a child that arrives before its parent when the parent was edited later', async () => {
    const server = newServer();
    const a = await createDevice(server, { name: 'a', accountId: ALICE });
    const b = await createDevice(server, { name: 'b', accountId: ALICE, pullLimit: 2 });
    const w = a.repos.workouts.start({ timeZone: 'UTC' });
    const we = a.repos.workoutExercises.add(w.id, 'leg-press');
    a.repos.sets.add(we.id, { weight: { value: 100, unit: 'kg' }, reps: 5 });
    await a.engine.run('manual');
    a.clock.advance(60_000);
    a.repos.workouts.complete(w.id); // the workout row now has the newest change number
    await a.engine.run('manual');

    await b.engine.run('manual');

    expect(b.engine.getStatus().lastFailure).toBeNull();
    expect(b.repos.workouts.get(w.id)?.endedAt).not.toBeNull();
    expect(b.repos.workoutExercises.listForWorkout(w.id)).toHaveLength(1);
    expect(b.repos.sets.listForWorkout(w.id)).toHaveLength(1);
    expect(b.repos.history.historyPage({ limit: 5 })).toHaveLength(1);
  });

  it('keeps foreign keys on after a pull', async () => {
    const server = newServer();
    const a = await createDevice(server, { name: 'a', accountId: ALICE });
    const b = await createDevice(server, { name: 'b', accountId: ALICE });
    oneWorkout(a);
    await a.engine.run('manual');
    await b.engine.run('manual');

    expect(() => b.repos.workoutExercises.add('no-such-workout', 'leg-press')).toThrow();
  });
});

describe('guest data and accounts', () => {
  it('moves the data logged as a guest into the account after the first sign in', async () => {
    const server = newServer();
    const d = await createDevice(server, { name: 'a', accountId: null });
    oneWorkout(d);
    await d.engine.run('start');
    expect(server.pushes).toHaveLength(0); // signed out: nothing is sent

    const result = await d.account.completeSignIn(fakeTokens(ALICE, Date.now()));
    expect(result).toEqual({ ok: true });
    await d.engine.run('signedIn');

    expect(server.stored(ALICE, 'workouts')).toHaveLength(1);
    expect(server.stored(ALICE, 'workoutSets')).toHaveLength(2);
    expect(dirtyCount(d)).toBe(0);
    expect(d.repos.history.historyPage({ limit: 5 })).toHaveLength(1);
  });

  it('merges guest data with what the account already has', async () => {
    const server = newServer();
    const other = await createDevice(server, { name: 'o', accountId: ALICE });
    oneWorkout(other, MONDAY);
    await other.engine.run('manual');
    const guest = await createDevice(server, { name: 'g', accountId: null });
    oneWorkout(guest, MONDAY + DAY_MS);

    await guest.account.completeSignIn(fakeTokens(ALICE, Date.now()));
    await guest.engine.run('signedIn');

    expect(guest.repos.history.historyPage({ limit: 5 })).toHaveLength(2);
    expect(server.stored(ALICE, 'workouts')).toHaveLength(2);
  });

  it('does nothing while signed out, and stops when the user signs out mid sync', async () => {
    const server = newServer();
    const d = await createDevice(server, { name: 'a', accountId: ALICE, batchSize: 3 });
    for (let i = 0; i < 4; i++) oneWorkout(d, MONDAY + i * DAY_MS);
    server.afterApply = () => void d.session.auth.signOut();

    await d.engine.run('manual');

    expect(server.pushes).toHaveLength(1); // no second batch after the sign out
    expect(dirtyCount(d)).toBeGreaterThan(0);
    expect(allWorkouts(d)).toHaveLength(4); // nothing lost
  });
});

describe('failures are quiet', () => {
  it.each([
    ['offline', undefined, 'offline'],
    ['a 500', 500, 'server'],
    ['a 429', 429, 'limited'],
    ['a 401 that stays a 401', 401, 'auth'],
  ])(
    'reports %s as %s without throwing and without losing anything',
    async (_label, status, expected) => {
      const server = newServer();
      const d = await createDevice(server, { name: 'a', accountId: ALICE });
      oneWorkout(d);
      if (status === undefined) server.offline = true;
      else server.failWith = status;

      await expect(d.engine.run('manual')).resolves.toBeUndefined();

      expect(d.engine.getStatus().lastFailure).toBe(expected);
      expect(d.engine.getStatus().running).toBe(false);
      expect(dirtyCount(d)).toBeGreaterThan(0);
      expect(allWorkouts(d)).toHaveLength(1);
    },
  );

  it('backs off after a 429 or a server error, except when the user does something', async () => {
    const server = newServer();
    const d = await createDevice(server, { name: 'a', accountId: ALICE });
    oneWorkout(d);
    server.failWith = 429;
    await d.engine.run('manual');
    server.failWith = undefined;
    server.pushes.length = 0;

    await d.engine.run('timer');
    expect(server.pushes).toHaveLength(0);

    await d.engine.run('manual');
    expect(server.pushes.length).toBeGreaterThan(0);
    expect(d.engine.getStatus().lastFailure).toBeNull();
  });

  it('records the time of the last success', async () => {
    const server = newServer();
    const d = await createDevice(server, { name: 'a', accountId: ALICE });
    expect(d.engine.getStatus().lastSuccessAt).toBeNull();

    await d.engine.run('start');

    expect(d.engine.getStatus().lastSuccessAt).not.toBeNull();
  });
});

describe('running in the background', () => {
  it('returns at once from syncSoon and does not wait for the network', async () => {
    const hang = jest.fn(() => new Promise<Response>(() => {})) as unknown as typeof fetch;
    const server = newServer();
    const d = await createDevice(server, { name: 'a', accountId: ALICE, fetch: hang });
    oneWorkout(d);

    // The request hangs, and the API client holds a 15 second timeout timer for it. Fake timers keep that timer
    // from outliving the test, which would hold the Jest worker open until it fired.
    jest.useFakeTimers();
    try {
      const returned = d.engine.syncSoon('workoutCompleted');

      expect(returned).toBeUndefined();
      // The logger keeps writing while the request hangs.
      const w = d.repos.workouts.start({ timeZone: 'UTC' });
      const we = d.repos.workoutExercises.add(w.id, 'leg-press');
      const set = d.repos.sets.add(we.id, { weight: { value: 60, unit: 'kg' }, reps: 8 });
      expect(set.reps).toBe(8);
      // Let the sync reach the hanging request, then drop its timer.
      await jest.advanceTimersByTimeAsync(0);
      expect(hang).toHaveBeenCalled();
    } finally {
      jest.clearAllTimers();
      jest.useRealTimers();
    }
  });

  it('runs one sync at a time and goes round once more for a request that came in meanwhile', async () => {
    const server = newServer();
    const d = await createDevice(server, { name: 'a', accountId: ALICE });
    oneWorkout(d);
    let added = false;
    server.afterApply = () => {
      if (added) return;
      added = true;
      oneWorkout(d, MONDAY + DAY_MS); // new work while the first push is in flight
    };

    const first = d.engine.run('manual');
    const second = d.engine.run('manual');
    const third = d.engine.run('manual');
    await Promise.all([first, second, third]);

    expect(dirtyCount(d)).toBe(0);
    expect(server.stored(ALICE, 'workouts')).toHaveLength(2);
  });

  it('tells subscribers when it starts and when it ends', async () => {
    const server = newServer();
    const d = await createDevice(server, { name: 'a', accountId: ALICE });
    const seen: boolean[] = [];
    d.engine.subscribe(() => seen.push(d.engine.getStatus().running));

    await d.engine.run('manual');

    expect(seen[0]).toBe(true);
    expect(seen.at(-1)).toBe(false);
  });
});

describe('what the device does with an incoming row', () => {
  const local = (
    over: Partial<{ deletedAt: number | null; dirty: boolean; updatedAt: number }> = {},
  ) => ({ deletedAt: null, dirty: false, updatedAt: 100, ...over });

  it.each([
    ['unknown here', undefined, { deletedAt: null, updatedAt: 50 }, 'insert'],
    [
      'deleted here, live there',
      local({ deletedAt: 90 }),
      { deletedAt: null, updatedAt: 500 },
      'skip',
    ],
    ['live here, deleted there', local(), { deletedAt: 120, updatedAt: 120 }, 'apply'],
    [
      'an unsent edit, deleted there',
      local({ dirty: true, updatedAt: 900 }),
      { deletedAt: 120, updatedAt: 120 },
      'apply',
    ],
    ['clean here, newer there', local(), { deletedAt: null, updatedAt: 200 }, 'apply'],
    ['clean here, older there', local(), { deletedAt: null, updatedAt: 50 }, 'apply'],
    [
      'an unsent edit, older there',
      local({ dirty: true, updatedAt: 200 }),
      { deletedAt: null, updatedAt: 100 },
      'skip',
    ],
    [
      'an unsent edit, the same time there',
      local({ dirty: true, updatedAt: 100 }),
      { deletedAt: null, updatedAt: 100 },
      'skip',
    ],
    [
      'an unsent edit, newer there',
      local({ dirty: true, updatedAt: 100 }),
      { deletedAt: null, updatedAt: 200 },
      'apply',
    ],
  ] as const)('%s: %s', (_label, current, incoming, expected) => {
    expect(decideIncoming(current as never, incoming)).toBe(expected);
  });
});
