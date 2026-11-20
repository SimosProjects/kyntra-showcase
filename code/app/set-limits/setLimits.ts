// Excerpt from the private Kyntra repository.
// Copyright (c) Meridion Systems. All rights reserved.
import { ValidationError } from './errors';

// The allowed values of a set, read by the set repository when it writes and by the entry form before it sends
// anything, so the two cannot disagree. Weight and distance are limited as typed, in the unit the person chose.
// Weight and distance match the server's column sizes (RowRules); the server allows more reps and a longer time.

export type SetLimit = {
  min: number;
  max: number;
  // Decimal places kept: 0 for whole numbers. The repository rounds weight and distance to this, and the form refuses
  // more, so what the field shows is what is saved.
  decimals: number;
};

export const SET_LIMITS = {
  weight: { min: 0, max: 9999.999, decimals: 3 },
  reps: { min: 0, max: 9999, decimals: 0 },
  // Seconds.
  duration: { min: 0, max: 86_400, decimals: 0 },
  distance: { min: 0, max: 999_999.999, decimals: 3 },
  rpe: { min: 0, max: 10, decimals: 2 },
} as const satisfies Record<string, SetLimit>;

export type SetLimitField = keyof typeof SET_LIMITS;

// What the repository accepts: a finite number in the range, and a whole number where no decimals are kept.
export function inRange(field: SetLimitField, value: number): boolean {
  const { min, max, decimals } = SET_LIMITS[field];
  return (
    Number.isFinite(value) &&
    value >= min &&
    value <= max &&
    (decimals > 0 || Number.isInteger(value))
  );
}

// What the form accepts: in range, and typed with no more decimals than are kept.
export function withinLimit(field: SetLimitField, value: number): boolean {
  if (!inRange(field, value)) return false;
  const factor = 10 ** SET_LIMITS[field].decimals;
  return Math.abs(Math.round(value * factor) - value * factor) < 1e-6;
}

// Thrown by the set repository for a value outside SET_LIMITS. The message names the field, never the value.
export class SetValueError extends ValidationError {
  constructor(readonly field: SetLimitField) {
    super(`${field} is out of range.`);
    this.name = 'ValidationError';
  }
}
