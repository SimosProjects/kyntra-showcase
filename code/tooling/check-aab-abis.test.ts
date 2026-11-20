// Excerpt from the private Kyntra repository.
// Copyright (c) Meridion Systems. All rights reserved.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const APP = resolve(__dirname, '..');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { abiProblems, librariesByAbi, EXPECTED_ABIS } = require('./check-aab-abis') as {
  abiProblems: (byAbi: Map<string, Set<string>>, expected?: string[]) => string[];
  librariesByAbi: (paths: string[]) => Map<string, Set<string>>;
  EXPECTED_ABIS: string[];
};

const bundle = (libs: Record<string, string[]>) =>
  Object.entries(libs).flatMap(([abi, files]) => files.map((file) => `base/lib/${abi}/${file}`));

const SHARED = ['libreactnative.so', 'libhermesvm.so'];

describe('check-aab-abis', () => {
  it('passes a bundle with the same libraries in every ABI', () => {
    const paths = bundle(Object.fromEntries(EXPECTED_ABIS.map((abi) => [abi, SHARED])));
    expect(abiProblems(librariesByAbi([...paths, 'base/manifest/AndroidManifest.xml']))).toEqual(
      [],
    );
  });

  it('fails build 3: libexpo-sqlite.so in arm64-v8a only', () => {
    const paths = bundle({
      'arm64-v8a': [...SHARED, 'libexpo-sqlite.so'],
      'armeabi-v7a': SHARED,
      x86: SHARED,
      x86_64: SHARED,
    });
    expect(abiProblems(librariesByAbi(paths))).toEqual([
      'armeabi-v7a: missing libexpo-sqlite.so',
      'x86: missing libexpo-sqlite.so',
      'x86_64: missing libexpo-sqlite.so',
    ]);
  });

  it('fails a bundle without an ABI that Play serves', () => {
    const paths = bundle({ 'arm64-v8a': SHARED, 'armeabi-v7a': SHARED, x86_64: SHARED });
    expect(abiProblems(librariesByAbi(paths))).toEqual(['x86: no native libraries']);
  });

  it('reads libraries in feature modules too', () => {
    expect([...librariesByAbi(['feature/lib/x86/libfeature.so']).keys()]).toEqual(['x86']);
  });

  it('runs after every local release build', () => {
    const script = readFileSync(resolve(APP, 'scripts/android-release.sh'), 'utf8');
    expect(script).toMatch(/node "\$APP\/scripts\/check-aab-abis\.js" "\$BUNDLE"/);
  });

  it('builds expo-sqlite from source, since its prebuilt package has arm64-v8a only', () => {
    const pkg = JSON.parse(readFileSync(resolve(APP, 'package.json'), 'utf8')) as {
      expo?: { autolinking?: { android?: { buildFromSource?: string[] } } };
    };
    expect(pkg.expo?.autolinking?.android?.buildFromSource).toContain('expo-sqlite');
  });
});
