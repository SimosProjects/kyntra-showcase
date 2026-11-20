# Android crash at start: a native library shipped for one ABI only

## What happened

An Android test build crashed at start on some devices. Sentry showed the app failing to open its local database:

```
Call to function 'NativeDatabase.constructor' has been rejected.
Caused by: java.lang.UnsatisfiedLinkError: dlopen failed: library "libexpo-sqlite.so" not found
```

Tapping Try again on the error screen gave a second error, `NoClassDefFoundError:
expo.modules.sqlite.NativeDatabaseBinding`. The app is offline first, so without SQLite it can do nothing.

## The cause

`expo-sqlite` 57.0.5 ships a prebuilt Android library (an AAR) inside its npm package, and Expo's autolinking uses
that AAR instead of building the module from source. That AAR had `libexpo-sqlite.so` for `arm64-v8a` only.

The app bundle targets four ABIs: `arm64-v8a`, `armeabi-v7a`, `x86` and `x86_64`. Every other native library was
present in all four. Google Play serves each device the split for its own ABI, so an `arm64-v8a` phone got SQLite and
every other device got a set of libraries without it.

The second error follows from the first. The class that loads the library does it in a static initializer. Once
that fails, Android marks the class as failed, and the next attempt gets `NoClassDefFoundError`.

## How I found it

1. I listed the native libraries per ABI in the release bundle (`unzip -l` on the `.aab`). `arm64-v8a` had 28,
   the other three had 27. The missing one was `libexpo-sqlite.so`.
2. I used bundletool to build the APK sets Play would serve one device of each ABI. Same result.
3. In `node_modules`, the expo-sqlite AAR had one native library, under `jni/arm64-v8a/`. The Gradle log had no
   compile task for expo-sqlite at all, which confirmed the prebuilt AAR was used.
4. I ruled out the usual suspects: no `abiFilters` in the app's Gradle file, the default
   `reactNativeArchitectures` list, no legacy packaging, and none of my config plugins touch native libraries.
5. My Mac's emulator is `arm64-v8a` only, so I reproduced it by removing the library from the arm64 split and
   installing that. Logcat showed both errors word for word as Sentry had them.

## The fix

Expo autolinking has an option for exactly this: build a named package from source instead of using its prebuilt
AAR.

```json
"expo": { "autolinking": { "android": { "buildFromSource": ["expo-sqlite"] } } }
```

Gradle then compiles expo-sqlite for every ABI in `reactNativeArchitectures`, like every other native module. After
the fix every ABI has the same 28 libraries. Download size grew by under 1 MB on the three ABIs that gained the
library and did not change on `arm64-v8a`.

I chose this over pinning an older version (no 57.x had a complete AAR) and over setting a Gradle property that
turns off the AAR as a side effect. `buildFromSource` names the package and says why it is there.

## What it prevents now

- `scripts/check-aab-abis.js` reads the finished bundle, lists the `.so` files per ABI, and fails when a library
  one ABI has is missing from another, or when an expected ABI has none. It runs at the end of every local release
  build. On the broken bundle it names `libexpo-sqlite.so` for the three missing ABIs.
- It reads what Play will receive, not the Gradle setup, so it catches a gap whatever causes it.
- Its tests include this exact case, check that the release script still runs it, and check that expo-sqlite is
  still built from source.
- CI does not build the native app, so the check lives in the release build step, which runs before every upload.
