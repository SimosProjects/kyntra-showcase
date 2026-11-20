// Excerpt from the private Kyntra repository.
// Copyright (c) Meridion Systems. All rights reserved.
// Loads the app config the way an EAS build does for the "production" profile, once for Android and once for iOS, and
// fails if it cannot. A production Android build once failed on EAS before building: app.config.ts loads the config
// plugins through Node's own module loader, and EAS ran Node 22, whose CommonJS lexer did not find a named import that
// Node 24 finds. Every local check had passed on Node 24.
//
// So the Node version is part of the check. eas.json pins the same Node for every build profile as .nvmrc, the version
// used locally and in CI, and this fails when the two differ or when the running Node is another one. Then it
// evaluates the config with the plugins applied (expo config --type introspect), with the profile's variables from
// eas.json and the ones EAS sets on its servers.
//
// Usage: node scripts/check-eas-config.js (npm run config:check). Run in CI and by scripts/android-release.sh.
const { execFileSync } = require('child_process');
const { readFileSync } = require('fs');
const { join } = require('path');

const APP = join(__dirname, '..');
const PROFILE = 'production';
const PLATFORMS = ['android', 'ios'];

// Values EAS adds from its "production" environment, which the repository does not have. Stand-ins of the same shape
// unless set in the shell, as in scripts/android-release.sh.
const STAND_INS = {
  EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID: '123456-iosclient.apps.googleusercontent.com',
  EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID: '123456-webclient.apps.googleusercontent.com',
  EXPO_PUBLIC_APPLE_SERVICES_ID: 'com.example.kyntra.web',
};

/** Each problem as a line: a build profile without the .nvmrc Node, or a running Node that is not it. */
function nodeProblems(nvmrc, easJson, running) {
  const expected = nvmrc.trim();
  const problems = [];
  if (!/^\d+\.\d+\.\d+$/.test(expected)) {
    problems.push(`.nvmrc must name an exact Node version (like 24.21.0), not "${expected}".`);
  }
  for (const [name, profile] of Object.entries(easJson.build ?? {})) {
    if (profile.node !== expected) {
      problems.push(
        `eas.json build profile "${name}" has node ${profile.node ?? '(unset, the build image default)'}, not ${expected} from .nvmrc.`,
      );
    }
  }
  if (running !== expected) {
    problems.push(`Running Node ${running}, not ${expected} from .nvmrc. Run nvm use.`);
  }
  return problems;
}

/** The environment an EAS build of the profile reads the config with, on one platform. */
function buildEnv(easJson, platform, base) {
  return {
    ...STAND_INS,
    ...base,
    ...(easJson.build?.[PROFILE]?.env ?? {}),
    EAS_BUILD: 'true',
    EAS_BUILD_PLATFORM: platform,
    EAS_BUILD_PROFILE: PROFILE,
    NODE_ENV: 'production',
    CI: '1',
    FORCE_COLOR: '0',
  };
}

function main() {
  const nvmrc = readFileSync(join(APP, '..', '..', '.nvmrc'), 'utf8');
  const easJson = JSON.parse(readFileSync(join(APP, 'eas.json'), 'utf8'));
  const problems = nodeProblems(nvmrc, easJson, process.versions.node);

  for (const platform of PLATFORMS) {
    try {
      const output = execFileSync('npx', ['expo', 'config', '--type', 'introspect', '--json'], {
        cwd: APP,
        env: buildEnv(easJson, platform, process.env),
        encoding: 'utf8',
        maxBuffer: 20 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      JSON.parse(output);
      console.log(`${platform}: the ${PROFILE} config loads on Node ${process.versions.node}.`);
    } catch (error) {
      const detail = String(error.stderr || error.message).trim();
      problems.push(`${platform}: the ${PROFILE} config does not load.\n${detail}`);
    }
  }

  if (problems.length > 0) {
    for (const problem of problems) console.error(problem);
    process.exit(1);
  }
  console.log(`The ${PROFILE} config loads as on EAS, on Android and iOS.`);
}

if (require.main === module) main();

module.exports = { nodeProblems, buildEnv };
