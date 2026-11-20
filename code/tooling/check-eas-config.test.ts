// Excerpt from the private Kyntra repository.
// Copyright (c) Meridion Systems. All rights reserved.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

type EasJson = { build?: Record<string, { node?: string; env?: Record<string, string> }> };

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { nodeProblems, buildEnv } = require('./check-eas-config') as {
  nodeProblems: (nvmrc: string, easJson: EasJson, running: string) => string[];
  buildEnv: (
    easJson: EasJson,
    platform: string,
    base: Record<string, string | undefined>,
  ) => Record<string, string | undefined>;
};

const APP = resolve(__dirname, '..');

describe('check-eas-config', () => {
  it('passes the repository: every build profile has the Node in .nvmrc', () => {
    const nvmrc = readFileSync(resolve(APP, '..', '..', '.nvmrc'), 'utf8');
    const easJson = JSON.parse(readFileSync(resolve(APP, 'eas.json'), 'utf8')) as EasJson;
    expect(nodeProblems(nvmrc, easJson, nvmrc.trim())).toEqual([]);
  });

  it('fails a profile on the build image default Node, as main was', () => {
    const problems = nodeProblems(
      '24.21.0\n',
      { build: { production: {}, preview: { node: '24.21.0' } } },
      '24.21.0',
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('"production"');
  });

  it('fails a profile on another Node, a running Node that differs and an inexact .nvmrc', () => {
    expect(
      nodeProblems('24.21.0', { build: { production: { node: '22.23.1' } } }, '24.21.0'),
    ).toHaveLength(1);
    expect(
      nodeProblems('24.21.0', { build: { production: { node: '24.21.0' } } }, '22.23.1'),
    ).toHaveLength(1);
    expect(nodeProblems('24', { build: { production: { node: '24' } } }, '24')).toHaveLength(1);
  });

  it('reads the config with the profile variables and the ones EAS sets', () => {
    const env = buildEnv({ build: { production: { env: { APP_VARIANT: 'production' } } } }, 'ios', {
      APP_VARIANT: 'development',
      PATH: '/bin',
    });
    expect(env).toMatchObject({
      APP_VARIANT: 'production',
      EAS_BUILD: 'true',
      EAS_BUILD_PLATFORM: 'ios',
      EAS_BUILD_PROFILE: 'production',
      PATH: '/bin',
    });
  });
});
