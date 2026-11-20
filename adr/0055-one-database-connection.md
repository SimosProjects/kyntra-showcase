# ADR 0055: One database connection per runtime, and two settings that no longer recreate the Android screen

Status: accepted

Lightly edited for outside readers. The incident behind it is in
[engineering-notes/database-closed-by-the-garbage-collector.md](../engineering-notes/database-closed-by-the-garbage-collector.md).

## Context

Android destroys and creates MainActivity again, in the same process, on a configuration change the manifest does
not declare in `android:configChanges`. Expo's template declares rotation, screen size, dark mode (`uiMode`), the
navigation mode (`assetsPaths`), language and layout direction, but not font size (`fontScale`), display size
(`density`) or bold text (`fontWeightAdjustment`). A change made while the app is in the background, in Settings or
while Apple's sign-in page is open in Chrome, recreates the activity when the person comes back.

React Native keeps the JavaScript runtime, but starts the app's surface again: the whole React tree unmounts and
mounts. `DatabaseProvider` then opened the database again. In expo-sqlite 57.0.5, `openDatabaseSync` with the same
name returns the native `NativeDatabase` already in the module's cache, now with a second JavaScript object. When the
garbage collector releases the first JavaScript object, expo-modules-core calls `sharedObjectDidRelease` on the
native object, and expo-sqlite's Android `NativeDatabase` closes its JNI binding (`HybridData.resetNative()`). The
second object still points at it, so every later call on it (`prepareSync`, `execSync`) is rejected with a
`NullPointerException`. Opening again, as the error screen's Try again did, got the same dead object from the cache,
so only closing the app recovered.

## Decision

- **One connection per JavaScript runtime.** `initRepositories` keeps the opened database and its repositories, and
  a later mount reuses them. A remount opens nothing, so no second JavaScript object ever shares the native handle.
- **A connection of its own.** `openDatabase` passes `useNewConnection: true`, so expo-sqlite never hands back a
  cached native object.
- **A dead connection is replaced.** A later mount checks the kept connection with `SELECT 1`. If it fails, or the
  last open failed, it opens a new connection. The error screen's Try again mounts `DatabaseProvider` again, so it
  recovers without closing the app. Every change is written to SQLite when it is made, so nothing is lost.
- **Display size and bold text change in place.** A small config plugin adds `density` and `fontWeightAdjustment`
  to MainActivity's `android:configChanges`. React Native lays the app out again at the new display size, and the
  app's own fonts do not follow bold text. What is on screen and not saved yet stays: the set form's values, the
  open screen, a sign-in waiting on Chrome.
- **Font size still recreates the screen.** Handled in place, React Native 0.86 kept some texts at their old
  measured size and cut them off at the new one (button labels, the gym chip, the set form's caption). A recreated
  screen draws every text at the right size, and with one connection per runtime the database keeps working. What
  is lost is only what was on screen and not saved. Text at the right size for people who use large text matters
  more than keeping typed values across a font size change.

Not chosen:

- A retry inside the database layer (catch the native error, reopen, run the call again). The repositories hold the
  Drizzle database in closures, so a swap needs a proxy around every call, and whether a failed write ran is not
  always known. With one connection per runtime the dead handle does not happen in the first place.
- Reopening when the native side reports a recreated activity. It treats the symptom, and an object released by
  the garbage collector at any later time would still close the shared handle.

## Consequences

- A change that is still not declared (font size, a SIM change, a keyboard attached) recreates the activity and
  remounts the app, but the database keeps working, and the workout in progress comes back from SQLite.
- Handling font size in place can be tried again on a later React Native version.
- iOS keeps its root view on setting changes and its `NativeDatabase` does not close on release, so this did not
  occur there. The same code runs there.
- An update of expo-sqlite or React Native should be checked against this on an emulator.
