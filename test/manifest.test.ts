import { describe, expect, it } from 'vitest';

import { packageVersion, parseManifest, updateManifest } from '../src/manifest.js';

describe('release manifest', () => {
  it('reads and updates a root package manifest', () => {
    const manifest = parseManifest('{".":"1.2.3"}', '.release-please-manifest.json');

    expect(packageVersion(manifest, '.', '.release-please-manifest.json')).toBe('1.2.3');
    expect(updateManifest(manifest, '.', '1.3.0')).toBe('{\n  ".": "1.3.0"\n}\n');
  });

  it('bootstraps an empty manifest for a subdirectory package', () => {
    const manifest = parseManifest('{}', '.release-please-manifest.json');

    expect(packageVersion(manifest, 'packages/api', '.release-please-manifest.json')).toBeNull();
    expect(updateManifest(manifest, 'packages/api', '1.0.0')).toContain(
      '"packages/api": "1.0.0"',
    );
  });

  it('rejects invalid versions, mismatched paths, and multiple packages', () => {
    expect(() =>
      parseManifest('{".":"v1.2.3"}', '.release-please-manifest.json'),
    ).toThrow('must be a full SemVer');

    const mismatched = parseManifest(
      '{"packages/web":"1.0.0"}',
      '.release-please-manifest.json',
    );
    expect(() =>
      packageVersion(mismatched, 'packages/api', '.release-please-manifest.json'),
    ).toThrow('not configured package');

    const multiple = parseManifest(
      '{".":"1.0.0","packages/api":"1.0.0"}',
      '.release-please-manifest.json',
    );
    expect(() =>
      packageVersion(multiple, '.', '.release-please-manifest.json'),
    ).toThrow('contains multiple packages');
  });
});
