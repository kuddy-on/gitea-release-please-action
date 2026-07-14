import { describe, expect, it } from 'vitest';

import { calculateVersion } from '../src/versioning.js';
import type { ActionConfig, ParsedChange } from '../src/types.js';

const baseConfig: Pick<
  ActionConfig,
  | 'initialVersion'
  | 'releaseAs'
  | 'versioningStrategy'
  | 'bumpMinorPreMajor'
  | 'bumpPatchForMinorPreMajor'
  | 'prereleaseType'
  | 'prerelease'
> = {
  initialVersion: '1.0.0',
  versioningStrategy: 'default',
  bumpMinorPreMajor: false,
  bumpPatchForMinorPreMajor: false,
  prerelease: false,
};

function change(type: string, breaking = false, releaseAs?: string): ParsedChange {
  const result: ParsedChange = {
    sha: '1234567',
    url: 'https://gitea.example/acme/demo/commit/1234567',
    type,
    scope: null,
    subject: 'change',
    breaking,
    breakingNotes: [],
  };
  if (releaseAs) result.releaseAs = releaseAs;
  return result;
}

describe('version strategies', () => {
  it('uses the initial version before the first release', () => {
    expect(calculateVersion(null, [change('feat')], baseConfig)).toBe('1.0.0');
  });

  it('chooses the highest conventional bump', () => {
    expect(calculateVersion('1.2.3', [change('fix')], baseConfig)).toBe('1.2.4');
    expect(calculateVersion('1.2.3', [change('fix'), change('feat')], baseConfig)).toBe(
      '1.3.0',
    );
    expect(calculateVersion('1.2.3', [change('feat'), change('refactor', true)], baseConfig)).toBe(
      '2.0.0',
    );
  });

  it('supports pre-major compatibility switches', () => {
    expect(
      calculateVersion('0.2.3', [change('refactor', true)], {
        ...baseConfig,
        bumpMinorPreMajor: true,
      }),
    ).toBe('0.3.0');
    expect(
      calculateVersion('0.2.3', [change('feat')], {
        ...baseConfig,
        bumpPatchForMinorPreMajor: true,
      }),
    ).toBe('0.2.4');
  });

  it('supports Release-As and always-bump strategies', () => {
    expect(calculateVersion('1.2.3', [change('fix', false, '3.0.0')], baseConfig)).toBe(
      '3.0.0',
    );
    expect(
      calculateVersion('1.2.3', [change('feat')], {
        ...baseConfig,
        versioningStrategy: 'always-bump-patch',
      }),
    ).toBe('1.2.4');
  });

  it('increments prereleases with the configured identifier', () => {
    const prerelease = {
      ...baseConfig,
      versioningStrategy: 'prerelease' as const,
      prereleaseType: 'beta',
      prerelease: true,
    };
    expect(calculateVersion('1.2.3', [change('feat')], prerelease)).toBe('1.3.0-beta');
    expect(calculateVersion('1.3.0-beta', [change('fix')], prerelease)).toBe(
      '1.3.0-beta.1',
    );
  });

  it('finishes a prerelease line when prerelease publication is disabled', () => {
    expect(
      calculateVersion('1.3.0-beta.4', [change('fix')], {
        ...baseConfig,
        versioningStrategy: 'prerelease',
        prereleaseType: 'beta',
      }),
    ).toBe('1.3.0');
  });
});
