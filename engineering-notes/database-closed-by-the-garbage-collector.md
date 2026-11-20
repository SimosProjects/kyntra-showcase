# The database closed by the garbage collector

## What happened

Sentry showed two errors from an Android test build on a Galaxy A15:

```
Call to function 'NativeDatabase.prepareSync' has been rejected.
Caused by: java.lang.NullPointerException
```

and the same for `execSync`. The app showed its error screen, and Try again failed the same way. Only closing the
app recovered. Nothing in the breadcrumbs pointed at a code path of mine: the calls were ordinary reads.

## The cause

A chain of four things, none of them wrong on its own:

1. Android recreates the activity, in the same process, on a configuration change the manifest does not declare.
   Expo's template declares rotation, dark mode, language and a few more, but not font size, display size or bold
   text. A change made while the app is in the background recreates it when the person comes back.
2. React Native keeps the JavaScript runtime but mounts the whole React tree again. My `DatabaseProvider` opened
   the database on mount, so it opened it a second time.
3. expo-sqlite caches native database objects by name. The second open returned the same native object, now behind
   a second JavaScript object.
4. When the garbage collector released the first JavaScript object, expo-sqlite's Android code closed the native
   handle that both objects used. Every later call through the second object hit a dead handle. Try again opened
   again, got the same dead object from the cache, and failed.

The failure waited for a garbage collection, so it showed up a moment after the recreate, which is why the
breadcrumbs looked unrelated.

## How I found it

The breadcrumbs showed the app going to the background and coming back, and a trip to Chrome for Apple sign-in,
each followed shortly by a remount. On the emulator I changed one setting at a time with `adb` (font scale, display
density, bold text, dark mode, navigation mode) and watched logcat for `wm_relaunch_resume_activity` and React
Native's `Running "main"`. Font size, display size and bold text recreated the activity. After two font size changes
and a memory warning that forced a garbage collection, the exact Sentry error appeared. Reading the expo-sqlite and
expo-modules-core sources for the cache and the release callback explained the rest.

## The fix

- **One connection per JavaScript runtime.** `initRepositories` keeps the opened database and its repositories in
  module scope, and a later mount reuses them. Mounts that start at the same time share one open. A remount opens
  nothing, so no second JavaScript object ever shares the handle.
- **A connection of its own.** The app opens with `useNewConnection: true`, so expo-sqlite never hands back a cached
  native object.
- **A dead connection is replaced.** A later mount checks the kept connection with `SELECT 1`. If that fails, it
  opens a new one. Try again now recovers without closing the app. Every change is written to SQLite as it is made,
  so the workout in progress comes back whole.
- **Two settings handled in place.** A small config plugin adds display size and bold text to the activity's
  `configChanges`, so those no longer recreate the screen at all. I tried font size too, but React Native 0.86 kept
  some labels at their old measured size and cut them off. Readable large text matters more than keeping a half
  typed value, so font size still recreates the screen, safely now.

I decided against a retry inside the database layer. The repositories hold the database in closures, so swapping it
would need a proxy around every call, and after a failed write it is not always clear whether the write ran.

## What it prevents now

- Unit tests run the real `initRepositories` against SQLite files: one open for many mounts, one open for mounts at
  the same time, a dead connection replaced with saved data intact, and a failed open tried again.
- A component test unmounts and mounts the whole app tree in the same runtime with a workout in progress, then kills
  the connection and checks Try again brings the workout back. Five of the six new tests fail against the old code.
- The decision is recorded in ADR 0055, with steps to check again after an expo-sqlite or React Native update.
