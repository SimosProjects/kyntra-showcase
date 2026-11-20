# A build that failed only on the build server: Node versions

## What happened

The production Android build on EAS failed before it built anything:

```
Error reading Expo config at .../apps/mobile/app.config.ts:
The requested module 'expo/config-plugins.js' does not provide an export named 'AndroidConfig'
```

Every local check had passed, and so had CI. The same config loaded on my Mac.

## The cause

`app.config.ts` imports a few small config plugins of mine. Expo transpiles the config file itself, but the plugins
it imports go through Node's own module loader. They are TypeScript with `import` syntax, so Node strips the types
and loads them as ES modules. An ES module that imports a CommonJS package by name gets only the names that Node's
CommonJS lexer can find in that package's source.

`@expo/config-plugins` exports most names as plain getters, but a few, `AndroidConfig` among them, as getters that
call a lazy loader. Node 24's lexer finds those. Node 22's does not.

`eas.json` set no Node version, so EAS used its build image's default, Node 22. My Mac and CI used Node 24 from
`.nvmrc`. One plugin imported `AndroidConfig` by name, so the config loaded everywhere except on EAS.

## How I found it

I installed the exact Node version from the EAS build image with nvm and ran `npx expo config` on main. It failed
with the same error. Then I checked the lexer directly: on Node 22 it found 36 named exports in the package, on
Node 24 it found 44, including `AndroidConfig`. Two other plugins used the same import pattern but only imported
names that Node 22 finds, so they loaded by luck.

## The fix

- **The plugins read the package in a way that works on any Node.** A small module takes Node's default export
  (`module.exports`, which is complete under any version) and falls back to the namespace under loaders that do
  not provide one, such as Jest. The plugins import only types from the package directly, and those are erased.
- **One Node version everywhere.** `.nvmrc` now names an exact version, and every build profile in `eas.json` sets
  `node` to it. Local, CI and EAS run the same Node, so the same module loading.

I chose pinning over testing on two Node versions in CI. Following the build image's default would break again the
next time the image changes.

## What it prevents now

`scripts/check-eas-config.js` (`npm run config:check`):

- fails when `.nvmrc` is not an exact version, when any `eas.json` build profile's `node` differs from it, or when
  the running Node differs.
- loads the production config with every plugin applied (`expo config --type introspect`), with the profile's
  variables and the ones EAS sets, once for Android and once for iOS.

It runs in CI on every pull request, drafts included, and first in the local release build, before the long
native build. On the old main it fails with the exact EAS error when run on Node 22, and with the version problems
on Node 24. The decision is recorded as an ADR.
