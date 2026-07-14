import { describe, expect, it } from 'vitest';

import {
  buildPullRequestBody,
  hashContent,
  parseMarker,
  serializeMarker,
} from '../src/marker.js';
import type { ReleaseMarker } from '../src/types.js';

const marker: ReleaseMarker = {
  schema: 1,
  version: '0.1.0',
  tagName: 'v0.1.0',
  targetBranch: 'main',
  targetHeadSha: '1111111111111111',
  changelogPath: 'CHANGELOG.md',
  releaseNotesPath: 'RELEASE.md',
  fileHashes: {
    'CHANGELOG.md': hashContent('changelog'),
    'RELEASE.md': hashContent('notes'),
  },
};

describe('release PR marker', () => {
  it('round trips through the PR body', () => {
    const body = buildPullRequestBody(marker, '# v0.1.0\n\nNotes\n');
    expect(parseMarker(body)).toEqual(marker);
    expect(body).toContain(
      'This PR was generated with [Release Please](https://github.com/googleapis/release-please).',
    );
  });

  it('accepts markers created before target head tracking was added', () => {
    const legacyMarker = { ...marker };
    delete legacyMarker.targetHeadSha;

    expect(parseMarker(serializeMarker(legacyMarker))).toEqual(legacyMarker);
  });

  it('rejects malformed or incomplete markers', () => {
    expect(parseMarker('ordinary PR')).toBeNull();
    expect(parseMarker('<!-- gitea-release-please: {bad} -->')).toBeNull();
    expect(
      parseMarker('<!-- gitea-release-please: {"schema":1,"version":"1.0.0"} -->'),
    ).toBeNull();
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
  });

  it('serializes the marker on one line', () => {
    expect(serializeMarker(marker)).not.toContain('\n');
  });
});
