// Excerpt from the private Kyntra repository.
// Copyright (c) Meridion Systems. All rights reserved.
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

import { i18n } from '../i18n';
import { applyStoredLanguage } from '../i18n/language';
import { hideSplash } from '../startup/splash';
import { initRepositories } from './init';
import type { Repositories } from './repositories';

const RepositoriesContext = createContext<Repositories | null>(null);

type Props = {
  children: ReactNode;
  init?: () => Promise<Repositories>;
};

// Renders nothing until the local database is ready. The splash screen covers that gap,
// so there is no spinner.
export function DatabaseProvider({ children, init = initRepositories }: Props) {
  const [repositories, setRepositories] = useState<Repositories | null>(null);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    let cancelled = false;
    init().then(
      (ready) => {
        // The language the person chose, before the first screen is drawn.
        applyStoredLanguage(i18n, ready);
        if (!cancelled) setRepositories(ready);
      },
      (e: unknown) => {
        // The launch screen would cover the error, so it goes first.
        hideSplash();
        if (!cancelled) setError(e instanceof Error ? e : new Error('Database failed to start.'));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [init]);

  // A database that cannot open is not recoverable here. Throwing reaches crash reporting.
  if (error) throw error;
  if (!repositories) return null;
  return (
    <RepositoriesContext.Provider value={repositories}>{children}</RepositoriesContext.Provider>
  );
}

export function useRepositories(): Repositories {
  const value = useContext(RepositoriesContext);
  if (!value) throw new Error('useRepositories must be used inside DatabaseProvider.');
  return value;
}
