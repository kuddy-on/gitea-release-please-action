import { describe, expect, it } from 'vitest';

import {
  buildPullRequestBody,
  extractReleaseNotesFromPullRequestBody,
  hashContent,
  parseMarker,
  serializeMarker,
} from '../src/marker.js';
import type { ReleaseMarker } from '../src/types.js';

const marker: ReleaseMarker = {
  schema: 3,
  version: '0.1.0',
  tagName: 'v0.1.0',
  targetBranch: 'main',
  targetHeadSha: '1111111111111111',
  changelogPath: 'CHANGELOG.md',
  releaseNotesHash: hashContent('# v0.1.0\n\nNotes\n'),
  manifestPath: '.release-please-manifest.json',
  fileHashes: {
    'CHANGELOG.md': hashContent('changelog'),
    '.release-please-manifest.json': hashContent('{".":"0.1.0"}\n'),
  },
};

describe('release PR marker', () => {
  it('round trips through the PR body', () => {
    const body = buildPullRequestBody(marker, '# v0.1.0\n\nNotes\n');
    expect(parseMarker(body)).toEqual(marker);
    expect(extractReleaseNotesFromPullRequestBody(body)).toBe(
      '# v0.1.0\n\nNotes\n',
    );
    expect(body).toContain(
      'This PR was generated with [Gitea Release Please](https://github.com/kuddy-on/gitea-release-please-action).',
    );
  });

  it('accepts markers created before target head tracking was added', () => {
    const legacyMarker: ReleaseMarker = {
      ...marker,
      schema: 1,
      releaseNotesPath: 'RELEASE.md',
      fileHashes: {
        ...marker.fileHashes,
        'RELEASE.md': hashContent('notes'),
      },
    };
    delete legacyMarker.releaseNotesHash;
    delete legacyMarker.targetHeadSha;
    delete legacyMarker.manifestPath;
    delete legacyMarker.fileHashes['.release-please-manifest.json'];

    expect(parseMarker(serializeMarker(legacyMarker))).toEqual(legacyMarker);
  });

  it('rejects malformed or incomplete markers', () => {
    expect(parseMarker('ordinary PR')).toBeNull();
    expect(parseMarker('<!-- gitea-release-please: {bad} -->')).toBeNull();
    expect(
      parseMarker('<!-- gitea-release-please: {"schema":1,"version":"1.0.0"} -->'),
    ).toBeNull();
    const missingManifest = { ...marker };
    delete missingManifest.manifestPath;
    expect(parseMarker(serializeMarker(missingManifest))).toBeNull();
    expect(
      parseMarker(
        serializeMarker({
          ...marker,
          fileHashes: { ...marker.fileHashes, 'package.json': 'invalid' },
        }),
      ),
    ).toBeNull();
    expect(
      parseMarker(serializeMarker({ ...marker, targetHeadSha: 'not-a-sha' })),
    ).toBeNull();
    expect(
      parseMarker(serializeMarker({ ...marker, releaseNotesHash: 'invalid' })),
    ).toBeNull();
    expect(
      parseMarker(serializeMarker({ ...marker, releaseNotesPath: 'RELEASE.md' })),
    ).toBeNull();
  });

  it('returns null when the PR body has no stable release notes section', () => {
    expect(extractReleaseNotesFromPullRequestBody(serializeMarker(marker))).toBeNull();
  });

  it('serializes the marker on one line', () => {
    expect(serializeMarker(marker)).not.toContain('\n');
  });
});
