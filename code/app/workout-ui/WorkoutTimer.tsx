// Excerpt from the private Kyntra repository.
// Copyright (c) Meridion Systems. All rights reserved.
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { formatClock } from '../../i18n/locale';
import { countRender } from '../../perf/renderCount';
import { maxScale } from '../../theme';
import { AppText } from '../../ui';
import { workoutDurationMs } from '../duration';

const TICK_MS = 1000;

type Props = {
  startedAt: number;
  // Time spent in earlier pauses, and when the pause in progress began (null when not paused).
  pausedSeconds?: number;
  pausedAt?: number | null;
};

// Time since the workout started without the time it was paused, "38:12" and "1:05:09" from an hour up. It
// ticks once a second in this component alone, so nothing else on the screen re-renders. While paused it does
// not tick and the number greys out. A resumed workout keeps its start time, so the clock carries on from the
// original start.
export function WorkoutTimer(props: Props) {
  // A new key reads the clock afresh when the pause starts or ends, so the number never lags a tick behind.
  return <Clock key={props.pausedAt === null ? 'running' : 'paused'} {...props} />;
}

function Clock({ startedAt, pausedSeconds = 0, pausedAt = null }: Props) {
  countRender('WorkoutTimer');
  const { t } = useTranslation();
  // The clock is the state, and the elapsed time is worked out from it, so a new start time needs no reset.
  const [now, setNow] = useState(() => Date.now());

  const paused = pausedAt !== null;
  useEffect(() => {
    if (paused) return;
    const id = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(id);
  }, [paused]);

  const elapsed = workoutDurationMs({ startedAt, endedAt: null, pausedSeconds, pausedAt }, now);
  const text = formatClock(Math.floor(elapsed / 1000));
  return (
    <AppText
      variant="number"
      color={paused ? 'textMuted' : 'accent'}
      accessibilityRole="timer"
      accessibilityLabel={t(paused ? 'workout.elapsedPaused' : 'workout.elapsed', { time: text })}
      style={{ fontVariant: ['tabular-nums'] }}
      // It shares the header row with the title, so it grows less than the title does.
      maxFontSizeMultiplier={maxScale.number}
    >
      {text}
    </AppText>
  );
}
