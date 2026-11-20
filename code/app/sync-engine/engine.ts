// Excerpt from the private Kyntra repository.
// Copyright (c) Meridion Systems. All rights reserved.
import { ApiError, type ApiClient } from '../api/client';
import type { components } from '../api/schema';
import type { AuthStore } from '../auth/authStore';
import type { Repositories } from '../db/repositories';
import type { PushItem, SyncTable } from '../db/repositories/sync';
import type { GymSyncPort } from '../gyms/gymSync';
import { fromChanges, toPushRequest } from './convert';

export type SyncReason =
  'start' | 'signedIn' | 'foreground' | 'reconnect' | 'workoutCompleted' | 'timer' | 'manual';

export type SyncFailure = 'offline' | 'auth' | 'limited' | 'server' | 'local';

export type SyncStatus = {
  running: boolean;
  lastSuccessAt: number | null;
  lastFailure: SyncFailure | null;
  // Rows the server refused for their values. They stay on the device, unsent, until edited.
  rejectedRows: number;
};

export interface SyncController {
  // Asks for a sync and returns at once. Never throws and never waits for the network.
  syncSoon(reason: SyncReason): void;
  // Resolves when the sync that covers this request has finished. Never rejects. For the few places that must
  // know the outcome, such as signing out; read the result from the data or from getStatus.
  run(reason: SyncReason): Promise<void>;
  getStatus(): SyncStatus;
  subscribe(listener: () => void): () => void;
}

export type SyncDeps = {
  repos: Repositories;
  api: ApiClient;
  auth: AuthStore;
  // Gyms added on this device, sent before the workouts that name them.
  gyms?: GymSyncPort;
  now?: () => number;
  batchSize?: number;
  pullLimit?: number;
  // Lets the UI run between batches. Replaced in tests.
  yieldToUi?: () => Promise<void>;
};

const DEFAULT_BATCH = 200;
// Push and pull rounds in one cycle: one normal, one after a restore is found, one spare.
const MAX_ROUNDS = 3;
const DEFAULT_PULL = 500;
const BACKOFF_MS = 30_000;
// Reasons that go ahead even while backing off: the user did something that changes the picture.
const BYPASS_BACKOFF: ReadonlySet<SyncReason> = new Set(['signedIn', 'manual', 'reconnect']);

type Answer = components['schemas']['RowResult'] | components['schemas']['PreferenceResult'];

const keyOf = (item: { table: SyncTable; key: string; rev: number }) =>
  `${item.table}:${item.key}:${item.rev}`;

// Pushes the rows that changed on this device and pulls the ones that changed elsewhere, in
// the background. The UI and the logger never wait for it and never call it: they only ask for a
// sync, which returns at once. Only one sync runs at a time, and a request that comes in while
// one is running makes it go round once more.
export class SyncEngine implements SyncController {
  private status: SyncStatus = {
    running: false,
    lastSuccessAt: null,
    lastFailure: null,
    rejectedRows: 0,
  };
  private listeners = new Set<() => void>();
  private current: Promise<void> | null = null;
  private again = false;
  private blockedUntil = 0;
  // Rows the server refused, as table:key:rev. Editing a row changes its rev, so it is tried again.
  private rejected = new Set<string>();

  constructor(private readonly deps: SyncDeps) {}

  private now = () => (this.deps.now ?? Date.now)();

  getStatus = (): SyncStatus => this.status;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private update(patch: Partial<SyncStatus>) {
    this.status = { ...this.status, ...patch };
    this.listeners.forEach((l) => l());
  }

  syncSoon = (reason: SyncReason): void => {
    void this.run(reason);
  };

  run(reason: SyncReason): Promise<void> {
    if (this.current) {
      this.again = true;
      return this.current;
    }
    if (!BYPASS_BACKOFF.has(reason) && this.now() < this.blockedUntil) return Promise.resolve();

    const loop = (async () => {
      do {
        this.again = false;
        await this.cycle();
      } while (this.again);
    })().finally(() => {
      this.current = null;
    });
    this.current = loop;
    return loop;
  }

  private signedIn = () => this.deps.auth.getState().status === 'signedIn';

  // The account this cycle started for. An answer that arrives after a sign out, or after another
  // account signed in, is not written to the device.
  private stillSignedInAs(accountId: string | null): boolean {
    const state = this.deps.auth.getState();
    return state.status === 'signedIn' && state.accountId === accountId;
  }

  private accountId(): string | null {
    const state = this.deps.auth.getState();
    return state.status === 'signedIn' ? state.accountId : null;
  }

  private async cycle(): Promise<void> {
    await this.deps.auth.ready;
    if (!this.signedIn()) return;

    this.update({ running: true });
    try {
      const skipThisCycle = new Set<string>();
      // A pull that finds a restored server (a new data epoch) marks everything unsent; the cycle then goes round
      // again: push it all, then pull from the start. Bounded, so a server that keeps changing cannot loop forever.
      for (let round = 0; round < MAX_ROUNDS; round++) {
        for (;;) {
          if (!this.signedIn()) return;
          // Before any workout, so a gym that turns out to exist already is switched first and the
          // workouts that name it go up with the right id.
          await this.deps.gyms?.pushPending();
          const batch = this.deps.repos.sync.nextBatch(
            this.deps.batchSize ?? DEFAULT_BATCH,
            new Set([...this.rejected, ...skipThisCycle]),
          );
          if (batch.length === 0) break;

          const answers = await this.push(batch);
          const accepted = answers.filter(
            (a) => a.status === 'applied' || a.status === 'unchanged',
          );
          this.deps.repos.sync.markPushed(accepted.map((a) => a.item));

          const refused = answers.filter((a) => a.status === 'rejected');
          for (const answer of refused) this.rejected.add(keyOf(answer.item));
          this.deps.repos.sync.markRejected(
            refused.map((a) => ({
              table: a.item.table,
              key: a.item.key,
              rev: a.item.rev,
              reason: a.reason ?? 'rejected',
            })),
          );
          // The server has a newer copy or a delete: take it now, before sending anything else.
          const behind = answers.filter((a) => a.status === 'stale' || a.status === 'deleted');
          if (behind.length > 0) await this.pull();
          // Whatever is still unsent after that (a tie the server kept) is left for the next cycle.
          for (const answer of behind) {
            if (this.deps.repos.sync.isStillDirty(answer.item))
              skipThisCycle.add(keyOf(answer.item));
          }
          await (this.deps.yieldToUi ?? defaultYield)();
        }

        if (!(await this.pull())) break;
      }
      this.update({
        lastSuccessAt: this.now(),
        lastFailure: null,
        rejectedRows: this.rejected.size,
      });
    } catch (error) {
      const failure = classify(error);
      if (failure === 'limited' || failure === 'server')
        this.blockedUntil = this.now() + BACKOFF_MS;
      this.update({ lastFailure: failure, rejectedRows: this.rejected.size });
    } finally {
      this.update({ running: false });
    }
  }

  private async push(
    batch: PushItem[],
  ): Promise<{ item: PushItem; status: Answer['status']; reason: string | null }[]> {
    const result = await this.deps.api.post('/sync/push', toPushRequest(batch));
    // A restored server: everything is unsent again. The rows of this batch did reach it, so the answers below still
    // mark them as sent.
    this.deps.repos.sync.noteEpoch(result.epoch);

    // The answers come back per list, in the order the rows were sent.
    const lists: Record<SyncTable, readonly Answer[]> = {
      workout: result.workouts,
      workoutExercise: result.workoutExercises,
      workoutSet: result.workoutSets,
      preference: result.preferences,
      plan: result.plans ?? [],
      planExercise: result.planExercises ?? [],
      customExercise: result.customExercises ?? [],
    };
    const next: Record<SyncTable, number> = {
      workout: 0,
      workoutExercise: 0,
      workoutSet: 0,
      preference: 0,
      plan: 0,
      planExercise: 0,
      customExercise: 0,
    };
    return batch.map((item) => {
      const answer = lists[item.table][next[item.table]++];
      if (!answer) throw new ApiError('http', 500);
      return { item, status: answer.status, reason: answer.reason };
    });
  }

  // True when the server turned out to be restored, so the caller pushes everything before pulling again.
  private async pull(): Promise<boolean> {
    const startedAs = this.accountId();
    for (;;) {
      if (!this.stillSignedInAs(startedAs)) return false;
      const since = this.deps.repos.sync.getCursor();
      const page = await this.deps.api.get('/sync/changes', {
        query: { since, limit: this.deps.pullLimit ?? DEFAULT_PULL },
      });
      // The cursor is a 64 bit number. It stays far below 2^53, so a JS number holds it exactly.
      const cursor = Number(page.cursor);
      // Signed out, or another account signed in, while the request was on its way: what it
      // brought back belongs to a session that is over, so it is not written.
      if (!this.stillSignedInAs(startedAs)) return false;
      // A page from a restored server was asked for with the old cursor, so it is not applied.
      if (this.deps.repos.sync.noteEpoch(page.epoch) === 'changed') return true;
      this.deps.repos.sync.applyPage(fromChanges(page), Math.max(cursor, since));
      if (!page.hasMore || cursor <= since) return false;
      await (this.deps.yieldToUi ?? defaultYield)();
    }
  }
}

const defaultYield = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function classify(error: unknown): SyncFailure {
  if (error instanceof ApiError) {
    if (error.kind === 'network' || error.kind === 'timeout') return 'offline';
    if (error.kind === 'aborted') return 'offline';
    if (error.status === 401) return 'auth';
    if (error.status === 429) return 'limited';
    return 'server';
  }
  // A local database error. Reported as a status, never thrown into the UI.
  return 'local';
}
