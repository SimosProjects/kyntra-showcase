// Excerpt from the private Kyntra repository.
// Copyright (c) Meridion Systems. All rights reserved.
import * as Haptics from 'expo-haptics';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';
import { Keyboard, Pressable, StyleSheet } from 'react-native';

import { formatNumber } from '../../i18n/locale';
import { useLocale } from '../../i18n/useLocale';
import { measureToNextFrame } from '../../perf/marks';
import { countRender } from '../../perf/renderCount';
import { colors, MIN_TOUCH, space } from '../../theme';
import { AppText, Tag } from '../../ui';
import { formatDistance, formatWeight, setDetail } from '../format';
import { specForSet } from '../form';
import {
  useEntry,
  useIsEditing,
  useIsRecord,
  useSet,
  useSuperset,
  useWorkoutStore,
} from '../hooks';
import { GROUP_BAR } from '../supersetStyle';
import { SetEditor } from './SetEditor';
import { SwipeToDelete } from './SwipeToDelete';

type Props = { setId: string; number: number; exerciseId: string };

// Weight times reps, or weight then a clock for timed sets.
const SEPARATOR_REPS = ' \u00d7 ';
const SEPARATOR_TIMED = ' \u00b7 ';

// Re-renders only when its own set changes. Props are primitives so memo can skip it
// when a sibling is added or removed.
export const SetRow = memo(function SetRow({ setId, number, exerciseId }: Props) {
  countRender(`SetRow:${setId}`);
  const { t } = useTranslation();
  const locale = useLocale();
  const store = useWorkoutStore();
  const set = useSet(setId);
  const entry = useEntry(exerciseId);
  const isRecord = useIsRecord(setId, exerciseId);
  const editing = useIsEditing(setId);
  const superset = useSuperset(exerciseId);
  if (!set || !entry) return null;

  const { loadType, tracking, logType } = entry.exercise;
  const spec = { loadType, tracking, logType };

  if (editing) {
    return (
      <SetEditor
        key={setId}
        set={set}
        spec={specForSet(spec, set)}
        locale={locale}
        onCancel={() => {
          Keyboard.dismiss();
          store.endEdit();
        }}
        onSave={(input) => {
          const written = measureToNextFrame('set_edit', () => store.updateSet(setId, input));
          if (!written.ok) return written;
          void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
          Keyboard.dismiss();
          store.endEdit();
          return written;
        }}
      />
    );
  }

  const weight =
    set.weightValue !== null && set.weightUnit
      ? formatWeight(
          t,
          { value: set.weightValue, unit: set.weightUnit, basis: set.loadBasis },
          locale,
        )
      : loadType !== 'none' && tracking === 'reps'
        ? t('workout.bodyweight')
        : '';
  // The unit follows the number ("60 kg", "20 kg/side") and is drawn smaller and muted.
  const amount =
    set.weightValue !== null && set.weightUnit ? formatNumber(set.weightValue, locale) : '';
  const unitText = amount && weight.startsWith(amount) ? weight.slice(amount.length) : '';
  const timed = set.durationS !== null;
  const detail = setDetail(t, set, locale);
  const separator = weight && detail ? (timed ? SEPARATOR_TIMED : SEPARATOR_REPS) : '';
  const spokenTime = timed
    ? t('workout.durationSpoken', {
        minutes: Math.floor(set.durationS! / 60),
        seconds: set.durationS! % 60,
      })
    : null;
  const spokenDetail =
    spokenTime === null
      ? detail
      : set.distanceValue !== null && set.distanceUnit
        ? `${formatDistance(t, { value: set.distanceValue, unit: set.distanceUnit }, locale)}, ${spokenTime}`
        : spokenTime;
  const label = [
    t('workout.setNumber', { number }),
    weight,
    spokenDetail,
    isRecord ? t('records.spoken') : null,
  ]
    .filter(Boolean)
    .join(', ');

  const remove = () => store.requestDeleteSet(setId);

  return (
    <SwipeToDelete deleteLabel={t('undo.delete')} onDelete={remove} resetKey={setId}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityHint={t('workout.editSet', { number })}
        accessibilityActions={[{ name: 'delete', label: t('workout.deleteSet', { number }) }]}
        onAccessibilityAction={(e) => {
          if (e.nativeEvent.actionName === 'delete') remove();
        }}
        onPress={() => store.beginEdit(setId)}
        style={[styles.row, superset && styles.inGroup]}
      >
        <AppText variant="bodyStrong" color="textFaint" style={styles.number}>
          {number}
        </AppText>
        <AppText variant="number" color={isRecord ? 'accent' : 'text'} style={styles.summary}>
          {unitText ? amount : weight}
          {unitText ? (
            <AppText variant="unit" color={isRecord ? 'accent' : 'textMuted'}>
              {unitText}
            </AppText>
          ) : null}
          {separator}
          {detail}
        </AppText>
        {isRecord ? <Tag label={t('records.tag')} /> : null}
      </Pressable>
    </SwipeToDelete>
  );
});

const styles = StyleSheet.create({
  // The set rows sit on the exercise card: the same surface, no gap between them.
  row: {
    minHeight: MIN_TOUCH,
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: space[12],
    paddingHorizontal: space[14],
    paddingVertical: space[6],
    backgroundColor: colors.surface,
  },
  // The bar of the superset continues down the sets of its exercises.
  inGroup: { borderLeftWidth: GROUP_BAR, borderLeftColor: colors.accent },
  number: { minWidth: 18 },
  summary: { flex: 1, fontVariant: ['tabular-nums'] },
});
