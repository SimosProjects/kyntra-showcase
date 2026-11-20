// Excerpt from the private Kyntra repository.
// Copyright (c) Meridion Systems. All rights reserved.
// Lists the native libraries in each ABI of an Android app bundle and fails when one is missing from an ABI that Google
// Play serves. Android build 3 crashed at start on a device because the prebuilt expo-sqlite package had
// libexpo-sqlite.so for arm64-v8a only, so the app could not open its database anywhere else.
//
// Usage: node scripts/check-aab-abis.js <app-release.aab>. Run by scripts/android-release.sh after the build.
const { execFileSync } = require('child_process');

// The ABIs the build targets: reactNativeArchitectures in the generated gradle.properties, which is React Native's
// default list. Play serves each device the one that matches it.
const EXPECTED_ABIS = ['arm64-v8a', 'armeabi-v7a', 'x86', 'x86_64'];

/** The .so files per ABI, from the paths in a bundle (base/lib/<abi>/<file>, and the same in feature modules). */
function librariesByAbi(paths) {
  const byAbi = new Map();
  for (const entry of paths) {
    const match = /^[^/]+\/lib\/([^/]+)\/([^/]+\.so)$/.exec(entry);
    if (!match) continue;
    const [, abi, file] = match;
    if (!byAbi.has(abi)) byAbi.set(abi, new Set());
    byAbi.get(abi).add(file);
  }
  return byAbi;
}

/** Each problem as a line: an expected ABI with no libraries, or a library that one ABI has and another lacks. */
function abiProblems(byAbi, expected = EXPECTED_ABIS) {
  const problems = [];
  const abis = [...new Set([...expected, ...byAbi.keys()])].sort();
  const all = new Set([...byAbi.values()].flatMap((files) => [...files]));
  for (const abi of abis) {
    const files = byAbi.get(abi);
    if (!files) {
      problems.push(`${abi}: no native libraries`);
      continue;
    }
    for (const file of [...all].sort()) {
      if (!files.has(file)) problems.push(`${abi}: missing ${file}`);
    }
  }
  return problems;
}

function main(bundle) {
  if (!bundle) {
    process.stderr.write('Usage: node scripts/check-aab-abis.js <app-release.aab>\n');
    return 2;
  }
  const paths = execFileSync('unzip', ['-Z1', bundle], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
    .split('\n')
    .filter(Boolean);
  const byAbi = librariesByAbi(paths);
  for (const abi of [...byAbi.keys()].sort()) {
    process.stdout.write(`${abi}: ${byAbi.get(abi).size} libraries\n`);
  }
  const problems = abiProblems(byAbi);
  if (problems.length) {
    process.stderr.write(`Native libraries missing from the bundle:\n${problems.join('\n')}\n`);
    return 1;
  }
  process.stdout.write(
    `Every ABI has the same ${byAbi.values().next().value.size} native libraries.\n`,
  );
  return 0;
}

if (require.main === module) process.exit(main(process.argv[2]));

module.exports = { EXPECTED_ABIS, abiProblems, librariesByAbi };
