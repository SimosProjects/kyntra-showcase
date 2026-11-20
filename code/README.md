# Code excerpts

These files are copied from the private Kyntra repository as they are on `main`. Each file starts with a one-line
comment that marks it as an excerpt. They are not meant to build on their own: the rest of each project (the
persistence module, the test harness, the repositories, the theme) is not here.

Two changes from the originals: one test file is cut at a section boundary, marked in the file, and one
configuration stand-in value in `tooling/check-eas-config.js` is replaced with an example value.

## API (ASP.NET Core, .NET 10, EF Core, PostgreSQL)

### `api/sign-in-nonces/`

Server-issued, single-use nonces for Sign in with Apple and Google (ADR 0052).

- `SignInNonces.cs`: issues 32 random bytes, stores only the SHA-256, and uses a nonce with one atomic
  `ExecuteDeleteAsync`, so two racing requests cannot both win. Logging uses source-generated `LoggerMessage` and
  never includes the value.
- `AuthEndpoints.cs`: the auth route group with minimal APIs. Look at the order in `SignInAsync`: input validation
  first, then the provider token, then the nonce, so a bad token never uses up a nonce. Every failure is a
  `ProblemDetails` response, and every kind of bad token gets the same answer. Rate limiting is per policy, and
  `/logout` always answers 204 so it says nothing about the token.
- `NonceTests.cs`: integration tests through the real endpoints against PostgreSQL in Testcontainers. The race
  test (`Simultaneous_requests_with_one_nonce_sign_in_once`) fires six sign-ins with the same nonce and expects
  exactly one success. Others cover replay, expiry, a nonce the server never issued, a bad token not using up the
  nonce, the cleanup, and that nothing is logged.

### `api/sync/`

The server side of offline sync (ADR 0009).

- `SyncEndpoints.cs`: `POST /sync/push` and `GET /sync/changes`. Structural checks only (row count, duplicate ids,
  nulls), a body size limit, and the user id taken from the token and nowhere else.
- `SyncService.cs`: the push runs in one transaction under a per-user advisory lock, so change numbers commit in
  order. The pull reads every table in one repeatable read snapshot, so the cursor never skips a row. The comments
  explain the race each of these prevents. Each table is loaded with one query and saved with one batch.
- `Rows/LastWriterWins.cs` and `Rows/IRowMap.cs`: the conflict rules in one place, shared by every table through a
  small per-table map. Deletes win, later edits win, a replay changes nothing.
- `Rows/RowRules.cs`: normalization shared by every table: times cut to PostgreSQL's microsecond so a replay
  compares equal, control characters refused per row so one bad value cannot fail a batch.
- `SyncPushTests.cs` (cut after the offline section): replays create no duplicates, delete beats edit, two devices
  editing one set end with the later edit, rows from days offline keep their times.
- `SyncQueryCountTests.cs`: counts the SQL commands of a 200 row push, a replay, 200 edits and a pull, and fails if
  the count starts to grow with the batch size. A guard against N+1 queries.

## App (React Native, Expo, TypeScript, SQLite with Drizzle)

### `app/sync-engine/`

- `engine.ts`: the background sync loop. The UI only calls `syncSoon`, which returns at once and never throws.
  One sync runs at a time, and a request during a run makes it go round once more. A row's dirty flag is cleared
  only if its `rev` did not change while the push was in flight. Answers that arrive after a sign-out or an
  account switch are dropped. Failures become statuses with a backoff, never errors in the UI.
- `engine.test.ts`: runs the engine against a fake server and a real SQLite database: days of offline work,
  conflicts between two devices, refused rows, paging through a long history, guest data moving into an account,
  and a test that `syncSoon` returns before the network answers.

### `app/database-connection/`

The fix from ADR 0055 and the engineering note on the database closed by the garbage collector.

- `client.ts`: opens SQLite with its own native connection, WAL mode and foreign keys on.
- `init.ts`: one connection per JavaScript runtime, shared by concurrent mounts, checked with `SELECT 1` on reuse
  and replaced if it died. Dependencies are injected so the tests can use a real SQLite file.
- `DatabaseProvider.tsx`: renders nothing until the database is ready. The splash screen covers the gap, so there
  is no spinner.
- `init.test.ts` and `recreate.test.tsx`: the unit tests for the connection rules, and a component test that
  unmounts and mounts the whole app tree in one runtime, as Android does on a configuration change, then kills the
  connection and checks that Try again brings back the workout in progress.

### `app/set-limits/`

- `setLimits.ts`: the allowed range and decimal places of each set field, read by both the entry form and the set
  repository so the two cannot disagree. The error names the field and never the value.
- `setLimits.test.ts`: table tests of every value the form can hold, checked against what the repository accepts.
  It was written after a crash where the form accepted a value the repository then refused.

### `app/workout-ui/`

How a screen on the logging path is built.

- `SetRow.tsx`: one set in the workout list. Memoized with primitive props and reading its own slice of the store,
  so adding a set does not re-render the other rows. It builds a full spoken label (set number, weight, reps or
  time, record), exposes delete as an accessibility action as well as a swipe, formats numbers with the device
  locale, and takes all text from i18n. Edits are timed with a performance mark.
- `WorkoutTimer.tsx`: the workout clock. It ticks in its own component so nothing else re-renders, has a spoken
  label and the `timer` role, and caps how far it grows at large text sizes so it fits beside the title.
- `WorkoutTimer.test.tsx`: format cases, the tick, cleanup on unmount, and a test on the real workout screen that
  five ticks re-render only the timer, not the set rows or exercise headers.

## Tooling and CI

### `tooling/`

Release checks written after real build failures (see `engineering-notes/`).

- `check-aab-abis.js`: lists the native libraries per ABI in an Android App Bundle and fails when any ABI is
  missing one. Runs at the end of every local release build.
- `check-eas-config.js`: fails when `.nvmrc` and every EAS build profile do not pin the same exact Node version, then
  loads the production app config with all plugins applied, as EAS does, for Android and iOS. Runs in CI on every
  pull request.
- Both have tests, including the exact cases that failed in production builds.

### `ci/`

GitHub Actions. `ci.yml` decides from the changed files which checks run and ends with one required status check,
`ci passed`, so a docs-only pull request never leaves a required check pending. Draft pull requests get the light
checks. `mobile.yml` runs lint, Prettier, the type check, the EAS config check, a migration drift check and both Jest
projects. `api.yml` runs `dotnet format`, a Release build, the tests, a check that the generated TypeScript API
client matches the OpenAPI document, and a NuGet vulnerability gate. Actions are pinned to commit hashes.
