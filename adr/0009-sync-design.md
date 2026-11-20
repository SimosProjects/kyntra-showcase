# ADR 0009: Offline sync between the app and the API

Status: accepted

Edited for outside readers. It joins the server decision (ADR 0009) with the sync part of the app decision
(ADR 0010). Milestone numbers and internal references are removed.

## Context

Every workout change is written to SQLite on the phone first. The network is only used afterward, by a background
sync that the logging screen never waits for. The server needs two endpoints, `POST /sync/push` and
`GET /sync/changes`, and a set of rules that give the same result whatever order devices sync in.

The overall design was set earlier: row snapshots, last writer wins, deletes win, client-generated UUIDv7 keys, and
a pull cursor from a server sequence. This record keeps the decisions that design left open and what was found
while building it.

## Decision

### Server

- **Rows, not operations.** A push carries row snapshots for workouts, workout exercises, sets and preferences, at
  most 200 rows in all (`Sync:MaxBatchRows`), parents before children. The request body is capped at 2 MB. A push
  with more rows, a row sent twice, or a body that is not a batch is a 400.
- **Each row gets its own answer.** `applied` and `unchanged` mean the server has the row as sent, so the app clears
  its dirty flag. `stale` (the server has a newer copy) and `deleted` (the server has a tombstone) mean the app
  should pull and adopt the server's copy. `rejected` carries a reason code and never echoes a value
  (`invalid_value`, `future_timestamp`, `missing_parent`). One bad row never blocks the rest of the queue.
- **Conflict rules**, one implementation for all tables:
  - a row the server has never seen is stored, a deleted one too, so a late edit cannot bring it back.
  - a deleted row stays deleted.
  - a delete wins over an edit whatever the times say (the content is taken only if the delete is also the newer
    write).
  - between two edits the later `updated_at` wins.
  - the same row sent again changes nothing, with no write and no new change number, so a retry is free.
  - the same time with different content keeps the server's copy.
- **Times.** Stored as UTC to the microsecond (what PostgreSQL keeps), so a replay compares equal. Old times are
  accepted as sent, because a device can be offline for days. A time more than 24 hours ahead of the server clock
  (`Sync:MaxFutureSkewHours`) rejects the row. A phone with a wrong clock would otherwise write times that beat
  every later edit from the user's other devices.
- **Weights.** The typed value is stored exactly. A value with more than 3 decimal places is rejected instead of
  rounded, as are a missing or unknown unit, a mix of set and null weight columns, and values outside the columns.
  The derived kilograms, distance and RPE are rounded to the column scale before they are stored and compared.
- **Isolation.** Every query filters by the user id from the token. Primary keys are `(user_id, id)` and child
  foreign keys are `(user_id, parent_id)`. An app that reuses another user's id gets its own row, and a child that
  names another user's parent is `missing_parent`, the same answer as for an id that does not exist.
- **Change numbers and the pull cursor.** Rows get their `change_seq` from one sequence. Two things keep a cursor
  from skipping a row. A push takes a per-user advisory lock for the length of its transaction, so one user's pushes
  commit in sequence order. A pull reads all tables in one repeatable read snapshot, so it sees a whole number of
  pushes. The second was found by a test: with one query per table at the default isolation level, a push that
  committed between two of the queries made the cursor jump over a row that was never returned. The pull merges the
  tables by change number, returns at most `limit` rows (default 200, at most 500), deleted rows included, and
  returns a cursor and a `hasMore` flag.
- **No query per row.** A push loads the existing rows of a table with one query and saves with one batched write.
  A test counts the SQL commands for a 200 row push, a replay, 200 edits and a pull, and fails above a fixed budget.

### App

- **Push** takes unsynced rows oldest first with parents before children, 200 per request. A row's `dirty` flag is
  cleared only when the answer is `applied` or `unchanged` and the row's `rev` is still the one that was sent, so an
  edit made while the push was in flight is sent next. After `stale` or `deleted` the app pulls before sending more.
- **Pull** reads from the stored cursor, 500 rows a page, and applies each page and the new cursor in one
  transaction without marking rows unsynced. Incoming rows follow the same rules as the server: unknown rows are
  stored, a row deleted here stays deleted, a delete from the server always wins, and for two live copies the later
  `updated_at` wins.
- **Foreign keys are off while a pulled page is applied.** A child can arrive on an earlier page than a parent that
  was edited later, for example a workout finished after its sets. Everything is present when the pull ends.
- **A row the server refuses** stays on the device and is not sent again until it is edited (the edit changes its
  `rev`), so one bad row cannot block the queue.
- **One sync runs at a time.** A request that arrives while one runs makes it go round once more. Failures are
  statuses, not errors. After a 429 or a server error the periodic triggers wait 30 seconds, and sign-in, reconnect
  and manual requests go ahead.
- **Triggers:** app start, sign-in, coming to the foreground, the connection coming back, a 60 second timer that
  runs only while the app is active, and the summary screen after a workout ends. All of them return at once.
- **Status:** a cloud icon on the History tab, filled when nothing is unsent and outlined when something is. A
  workout card says "Not backed up yet" after 24 hours. No dialog, whatever the sync reports.

## Consequences

- A client that never pulls after a `stale` or `deleted` answer keeps a local copy that differs from the server.
  The sync loop pulls straight after any push that returned one.
- A user's pushes run one at a time. That is the cost of the ordering guarantee. Pushes from different users do not
  wait for each other.
- A refused row is not retried until edited. It is counted in the sync engine's status for diagnostics.
- The sync timer does not run in the background. Backing up happens while the app is open and when it returns to
  the foreground.
