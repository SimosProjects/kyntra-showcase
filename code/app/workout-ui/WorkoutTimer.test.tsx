// Excerpt from the private Kyntra repository.
// Copyright (c) Meridion Systems. All rights reserved.
import { act, render, screen } from '@testing-library/react-native';

import '../../i18n';
import { getRenderCount, resetRenderCounts } from '../../perf/renderCount';
import { WorkoutScreen } from '../../screens/WorkoutScreen';
import { fakeNavigation, renderWithApp } from '../test-render';
import { WorkoutTimer } from './WorkoutTimer';

const START = Date.UTC(2026, 9, 7, 12, 0, 0);

beforeEach(() => {
  jest.useFakeTimers({ now: START, advanceTimers: false });
  resetRenderCounts();
});
afterEach(() => jest.useRealTimers());

const secondsAgo = (s: number) => START - s * 1000;

describe('WorkoutTimer', () => {
  it.each([
    [0, '0:00'],
    [59, '0:59'],
    [60, '1:00'],
    [38 * 60 + 12, '38:12'],
    [59 * 60 + 59, '59:59'],
    [3600, '1:00:00'],
    [3600 + 5 * 60 + 9, '1:05:09'],
    [10 * 3600 + 1, '10:00:01'],
  ])('shows %s seconds as %s', async (seconds, text) => {
    await render(<WorkoutTimer startedAt={secondsAgo(seconds)} />);

    expect(screen.getByText(text)).toBeTruthy();
  });

  it('never goes below zero when the clock is behind the start', async () => {
    await render(<WorkoutTimer startedAt={START + 5000} />);

    expect(screen.getByText('0:00')).toBeTruthy();
  });

  it('ticks once a second', async () => {
    await render(<WorkoutTimer startedAt={secondsAgo(58)} />);
    expect(screen.getByText('0:58')).toBeTruthy();

    await act(async () => {
      jest.advanceTimersByTime(1000);
    });
    expect(screen.getByText('0:59')).toBeTruthy();
    await act(async () => {
      jest.advanceTimersByTime(2000);
    });
    expect(screen.getByText('1:01')).toBeTruthy();
    expect(getRenderCount('WorkoutTimer')).toBeLessThanOrEqual(5);
  });

  it('carries on from the original start when a workout is resumed later', async () => {
    // Started 40 minutes ago, finished, resumed 2 hours later: the clock counts from the start.
    jest.setSystemTime(START + 2 * 3600 * 1000);
    await render(<WorkoutTimer startedAt={START - 40 * 60 * 1000} />);

    expect(screen.getByText('2:40:00')).toBeTruthy();
  });

  it('has a spoken name with the time, and stops its timer when it goes away', async () => {
    const { unmount } = await render(<WorkoutTimer startedAt={secondsAgo(75)} />);

    expect(screen.getByLabelText('Workout time 1:15')).toBeTruthy();
    await unmount();
    const rendered = getRenderCount('WorkoutTimer');
    await act(async () => {
      jest.advanceTimersByTime(3000);
    });
    expect(getRenderCount('WorkoutTimer')).toBe(rendered);
  });
});

describe('the timer on the workout screen', () => {
  it('a tick re-renders only the timer, not the headers, rows or entry area', async () => {
    const { repos } = await renderWithApp(
      <WorkoutScreen navigation={fakeNavigation() as never} route={{} as never} />,
      {
        prepare: (r) => {
          const w = r.workouts.start({ timeZone: 'UTC' });
          const row = r.workoutExercises.add(w.id, 'barbell-bench-press');
          r.sets.add(row.id, { weight: { value: 60, unit: 'kg' }, reps: 8 });
        },
      },
    );
    await screen.findByText('60 kg × 8 reps');
    const active = repos.workouts.getActive()!;
    const set = repos.sets.listForWorkout(active.id)[0]!;
    const header = repos.workoutExercises.listForWorkout(active.id)[0]!;
    const before = {
      timer: getRenderCount('WorkoutTimer'),
      row: getRenderCount(`SetRow:${set.id}`),
      header: getRenderCount(`ExerciseHeader:${header.id}`),
    };

    // One second at a time, as the clock would, so each tick is its own render.
    for (let i = 0; i < 5; i++) {
      await act(async () => {
        jest.advanceTimersByTime(1000);
      });
    }

    expect(getRenderCount('WorkoutTimer')).toBeGreaterThanOrEqual(before.timer + 5);
    expect(getRenderCount(`SetRow:${set.id}`)).toBe(before.row);
    expect(getRenderCount(`ExerciseHeader:${header.id}`)).toBe(before.header);
  });

  it('shows the time since the workout started, in the header', async () => {
    await renderWithApp(
      <WorkoutScreen navigation={fakeNavigation() as never} route={{} as never} />,
      { prepare: (r) => void r.workouts.start({ timeZone: 'UTC' }) },
    );

    expect(await screen.findByRole('timer')).toBeTruthy();
  });
});
