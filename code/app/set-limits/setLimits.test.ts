// Excerpt from the private Kyntra repository.
// Copyright (c) Meridion Systems. All rights reserved.
import type { TFunction } from 'i18next';

import type { LoadType, LogType, TrackingMode } from '../db/catalog/types';
import { seedCatalog } from '../db/catalog/seed';
import { checkSetInput } from '../db/repositories/sets';
import { inRange, SET_LIMITS, SetValueError, withinLimit } from '../db/setLimits';
import { createTestDb, createTestRepositories } from '../db/test-utils';
import { i18n } from '../i18n';
import { problemMessage } from './components/SetFields';
import { buildSetInput, MAX_MINUTES, problemFor, type ComposerForm } from './form';

const form = (over: Partial<ComposerForm> = {}): ComposerForm => ({
  weightText: '',
  repsText: '',
  minutesText: '',
  secondsText: '',
  unit: 'kg',
  perSide: false,
  distanceText: '',
  distanceUnit: 'km',
  weightOpen: false,
  ...over,
});

const spec = (logType: LogType, loadType: LoadType) => ({
  loadType,
  tracking: (logType === 'duration' || logType === 'distance_duration'
    ? 'time'
    : 'reps') as TrackingMode,
  logType,
});

const weightReps = spec('weight_reps', 'external');
const bodyweight = spec('reps', 'none');
const hold = spec('duration', 'none');
const cardio = spec('distance_duration', 'none');

// What the repository says about the input the form built: null when it would write it.
function repositoryVerdict(input: Parameters<typeof checkSetInput>[0]): string | null {
  try {
    checkSetInput(input);
    return null;
  } catch (error) {
    return error instanceof SetValueError ? error.field : 'other';
  }
}

// Every value the composer can hold for a field, with what the form must do with it. A value the form accepts must also
// be accepted by the repository, which is what the crash in build 4 broke.
describe('reps', () => {
  it.each([
    ['', 'refused'],
    ['0', 0],
    ['8', 8],
    ['08', 8],
    ['0000008', 8],
    ['9999', 9999],
    ['09999', 9999],
    ['10000', 'refused'],
    ['81012', 'refused'],
    ['9999999999', 'refused'],
    ['-1', 'refused'],
    ['−5', 'refused'],
    ['8.5', 'refused'],
    ['8,5', 'refused'],
    ['8.', 'refused'],
    [' 12 ', 12],
    ['1 000', 'refused'],
    ['1.000', 'refused'],
    ['1e4', 'refused'],
    ['１２', 'refused'],
    ['12abc', 'refused'],
    ['+5', 'refused'],
    ['NaN', 'refused'],
    ['Infinity', 'refused'],
  ])('"%s" gives %s', (repsText, expected) => {
    for (const s of [weightReps, bodyweight]) {
      const result = buildSetInput(s, form({ weightText: '60', repsText }));
      if (expected === 'refused') {
        expect(result).toEqual({ ok: false, field: 'reps' });
      } else {
        expect(result).toMatchObject({ ok: true, input: { reps: expected } });
        if (result.ok) expect(repositoryVerdict(result.input)).toBeNull();
      }
    }
  });
});

describe('weight', () => {
  it.each([
    ['0', 0],
    ['60', 60],
    ['060', 60],
    ['22,5', 22.5],
    ['22.5', 22.5],
    [',5', 0.5],
    ['5,', 5],
    ['9999,999', 9999.999],
    ['9999.999', 9999.999],
    ['2,125', 2.125],
    ['10000', 'refused'],
    ['9999,9991', 'refused'],
    ['2,1255', 'refused'],
    ['99999', 'refused'],
    ['9999999999', 'refused'],
    ['-5', 'refused'],
    ['1.234,5', 'refused'],
    ['1,234.5', 'refused'],
    ['1 000', 'refused'],
    ['22,5 kg', 'refused'],
    ['1e3', 'refused'],
    [',', 'refused'],
    ['.', 'refused'],
  ])('"%s" gives %s', (weightText, expected) => {
    const result = buildSetInput(weightReps, form({ weightText, repsText: '8' }));
    if (expected === 'refused') {
      expect(result).toEqual({ ok: false, field: 'weight' });
    } else {
      expect(result).toMatchObject({ ok: true, input: { weight: { value: expected } } });
      if (result.ok) expect(repositoryVerdict(result.input)).toBeNull();
    }
  });

  it('is required for weight and reps, and optional where it is an extra', () => {
    expect(buildSetInput(weightReps, form({ repsText: '8' }))).toEqual({
      ok: false,
      field: 'weight',
    });
    expect(buildSetInput(spec('reps', 'bodyweight_plus'), form({ repsText: '8' }))).toMatchObject({
      ok: true,
      input: { weight: null },
    });
    expect(
      buildSetInput(spec('reps', 'bodyweight_plus'), form({ repsText: '8', weightText: '10000' })),
    ).toEqual({ ok: false, field: 'weight' });
  });

  // The limit is on the number as typed, in the unit chosen, so the same text gives the same answer in kg and lb, and
  // the kilograms it converts to never pass the server's column (99999.9999).
  it.each(['kg', 'lb'] as const)('has the same limit in %s', (unit) => {
    const at = buildSetInput(weightReps, form({ weightText: '9999,999', repsText: '1', unit }));
    expect(at).toMatchObject({ ok: true, input: { weight: { value: 9999.999, unit } } });
    if (at.ok) expect(repositoryVerdict(at.input)).toBeNull();
    expect(buildSetInput(weightReps, form({ weightText: '10000', repsText: '1', unit }))).toEqual({
      ok: false,
      field: 'weight',
    });
  });
});

describe('time', () => {
  it.each([
    ['', '30', 30],
    ['0', '45', 45],
    ['1', '05', 65],
    ['01', '5', 65],
    [String(MAX_MINUTES), '', SET_LIMITS.duration.max],
    [String(MAX_MINUTES), '0', SET_LIMITS.duration.max],
  ])('%s min %s s is %s seconds', (minutesText, secondsText, durationS) => {
    const result = buildSetInput(hold, form({ minutesText, secondsText }));
    expect(result).toMatchObject({ ok: true, input: { durationS } });
    if (result.ok) expect(repositoryVerdict(result.input)).toBeNull();
  });

  it.each([
    ['', '', 'time'],
    ['0', '0', 'time'],
    [String(MAX_MINUTES), '1', 'time'],
    [String(MAX_MINUTES + 1), '', 'minutes'],
    ['9999999999', '', 'minutes'],
    ['-1', '', 'minutes'],
    ['1,5', '', 'minutes'],
    ['1', '60', 'seconds'],
    ['1', '-5', 'seconds'],
    ['1', '5,5', 'seconds'],
    ['1', '9999999999', 'seconds'],
  ])('%s min %s s points at %s', (minutesText, secondsText, field) => {
    expect(buildSetInput(hold, form({ minutesText, secondsText }))).toEqual({ ok: false, field });
  });
});

describe('distance', () => {
  it.each([
    ['5', 5],
    ['5,25', 5.25],
    ['05.5', 5.5],
    ['999999,999', 999_999.999],
  ])('"%s" gives %s', (distanceText, expected) => {
    const result = buildSetInput(cardio, form({ minutesText: '25', distanceText }));
    expect(result).toMatchObject({ ok: true, input: { distance: { value: expected } } });
    if (result.ok) expect(repositoryVerdict(result.input)).toBeNull();
  });

  it.each(['0', '0,0', '-1', '1000000', '999999,9991', '5,2555', '1 000', 'abc'])(
    '"%s" is refused',
    (distanceText) => {
      expect(buildSetInput(cardio, form({ minutesText: '25', distanceText }))).toEqual({
        ok: false,
        field: 'distance',
      });
    },
  );
});

describe('the form and the repository share one set of limits', () => {
  const fields = Object.keys(SET_LIMITS) as (keyof typeof SET_LIMITS)[];

  it.each(fields)('%s: both take the limits and refuse just past them', (field) => {
    const { min, max, decimals } = SET_LIMITS[field];
    const step = 10 ** -decimals;
    expect(withinLimit(field, min)).toBe(true);
    expect(withinLimit(field, max)).toBe(true);
    expect(inRange(field, min)).toBe(true);
    expect(inRange(field, max)).toBe(true);
    for (const outside of [min - step, max + step, NaN, Infinity]) {
      expect(withinLimit(field, outside)).toBe(false);
      expect(inRange(field, outside)).toBe(false);
    }
  });

  // Each field's highest value goes through the form and then the repository, and one step past it is refused by both.
  it.each([
    ['reps', weightReps, { weightText: '1' }, 'repsText', SET_LIMITS.reps.max, 1],
    ['weight', weightReps, { repsText: '1' }, 'weightText', SET_LIMITS.weight.max, 0.001],
    ['distance', cardio, { minutesText: '1' }, 'distanceText', SET_LIMITS.distance.max, 0.001],
  ] as const)('%s', (field, s, rest, key, max, step) => {
    const at = buildSetInput(s, form({ ...rest, [key]: String(max) }));
    expect(at.ok).toBe(true);
    if (at.ok) expect(repositoryVerdict(at.input)).toBeNull();

    const past = Number((max + step).toFixed(3));
    expect(buildSetInput(s, form({ ...rest, [key]: String(past) }))).toEqual({
      ok: false,
      field,
    });
    const input =
      field === 'reps'
        ? { reps: past }
        : field === 'weight'
          ? { weight: { value: past, unit: 'kg' as const } }
          : { distance: { value: past, unit: 'km' as const } };
    expect(repositoryVerdict(input)).toBe(field);
  });

  it('the time limit is the repository duration limit', () => {
    expect(MAX_MINUTES * 60).toBe(SET_LIMITS.duration.max);
    expect(repositoryVerdict({ durationS: SET_LIMITS.duration.max })).toBeNull();
    expect(repositoryVerdict({ durationS: SET_LIMITS.duration.max + 1 })).toBe('duration');
  });

  it('a refusal from the repository points at the field the form shows', () => {
    expect(problemFor('reps')).toBe('reps');
    expect(problemFor('weight')).toBe('weight');
    expect(problemFor('distance')).toBe('distance');
    expect(problemFor('duration')).toBe('time');
    expect(problemFor('rpe')).toBe('set');
    expect(problemFor(null)).toBe('set');
  });

  it('the repository still writes nothing out of range', async () => {
    const { db } = await createTestDb();
    seedCatalog(db);
    const { repos } = createTestRepositories(db);
    const w = repos.workouts.start({ timeZone: 'UTC' });
    const we = repos.workoutExercises.add(w.id, 'barbell-bench-press');
    expect(() => repos.sets.add(we.id, { reps: 10_000 })).toThrow(SetValueError);
    expect(() => repos.sets.add(we.id, { reps: 10_000 })).toThrow('reps is out of range.');
    expect(repos.sets.listForWorkoutExercise(we.id)).toEqual([]);
  });
});

describe('the message', () => {
  const messages = (language: string) => {
    const t = i18n.getFixedT(language) as TFunction;
    const locale = language === 'es' ? 'es-ES' : 'en-US';
    return (problem: Parameters<typeof problemMessage>[1]) => problemMessage(t, problem, locale);
  };

  it('gives the real limits in English', () => {
    const say = messages('en');
    expect(say('reps')).toBe('Reps must be a whole number between 0 and 9,999.');
    expect(say('weight')).toBe('Weight must be between 0 and 9,999.999.');
    expect(say('minutes')).toBe('Minutes must be a whole number between 0 and 1,440.');
    expect(say('seconds')).toBe('Seconds must be a whole number between 0 and 59.');
    expect(say('time')).toBe('The time must be between 1 second and 24 hours.');
    expect(say('distance')).toBe('Distance must be more than 0 and no more than 999,999.999.');
    expect(say('set')).toBe('This set could not be saved. Check the numbers and try again.');
  });

  it('gives the real limits in Spanish, with a decimal comma', () => {
    const say = messages('es');
    expect(say('reps')).toBe('Las repeticiones deben ser un número entero entre 0 y 9999.');
    expect(say('weight')).toBe('El peso debe estar entre 0 y 9999,999.');
    expect(say('minutes')).toBe('Los minutos deben ser un número entero entre 0 y 1440.');
    expect(say('time')).toBe('El tiempo debe estar entre 1 segundo y 24 horas.');
    expect(say('distance')).toBe('La distancia debe ser mayor que 0 y como máximo 999.999,999.');
    expect(say('set')).toBe(
      'No se pudo guardar esta serie. Revisa los números e inténtalo de nuevo.',
    );
  });
});
