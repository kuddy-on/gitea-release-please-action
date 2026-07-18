import { createHash } from 'node:crypto';

import type { ReleaseMarker } from './types.js';

const MARKER_PATTERN = /<!--\s*gitea-release-please:\s*(\{[^\r\n]*\})\s*-->/;
const RELEASE_NOTES_PATTERN =
  /<!--\s*gitea-release-please:release-notes:start\s*-->([\s\S]*?)<!--\s*gitea-release-please:release-notes:end\s*-->/;
const RELEASE_NOTES_START = '<!-- gitea-release-please:release-notes:start -->';
const RELEASE_NOTES_END = '<!-- gitea-release-please:release-notes:end -->';

export function hashContent(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

export function serializeMarker(marker: ReleaseMarker): string {
  return `<!-- gitea-release-please: ${JSON.stringify(marker)} -->`;
}

export function parseMarker(body: string): ReleaseMarker | null {
  const match = body.match(MARKER_PATTERN);
  if (!match?.[1]) return null;

  try {
    const candidate: unknown = JSON.parse(match[1]);
    if (!isMarker(candidate)) return null;
    return candidate;
  } catch {
    return null;
  }
}

function isMarker(value: unknown): value is ReleaseMarker {
  if (!value || typeof value !== 'object') return false;
  const marker = value as Partial<ReleaseMarker>;
  const fileHashes = marker.fileHashes;
  if (
    (marker.schema !== 1 && marker.schema !== 2 && marker.schema !== 3) ||
    (marker.path !== undefined && typeof marker.path !== 'string') ||
    typeof marker.version !== 'string' ||
    typeof marker.tagName !== 'string' ||
    typeof marker.targetBranch !== 'string' ||
    (marker.targetHeadSha !== undefined &&
      (typeof marker.targetHeadSha !== 'string' ||
        !/^[0-9a-f]{7,64}$/.test(marker.targetHeadSha))) ||
    (marker.changelogPath !== undefined && typeof marker.changelogPath !== 'string') ||
    (marker.releaseNotesPath !== undefined && typeof marker.releaseNotesPath !== 'string') ||
    (marker.releaseNotesHash !== undefined &&
      (typeof marker.releaseNotesHash !== 'string' ||
        !/^[0-9a-f]{64}$/.test(marker.releaseNotesHash))) ||
    (marker.manifestPath !== undefined && typeof marker.manifestPath !== 'string') ||
    !fileHashes ||
    typeof fileHashes !== 'object'
  ) {
    return false;
  }
  const changelogHash = marker.changelogPath
    ? fileHashes[marker.changelogPath]
    : undefined;
  const legacyReleaseNotesHash = marker.releaseNotesPath
    ? fileHashes[marker.releaseNotesPath]
    : undefined;
  const manifestHash = marker.manifestPath
    ? fileHashes[marker.manifestPath]
    : undefined;
  const validFileHashes =
    Object.entries(fileHashes).every(
      ([path, hash]) => path !== '' && typeof hash === 'string' && /^[0-9a-f]{64}$/.test(hash),
    );
  const validChangelog =
    (marker.changelogPath === undefined ||
      (typeof changelogHash === 'string' && /^[0-9a-f]{64}$/.test(changelogHash)));
  const validManifest =
    typeof marker.manifestPath === 'string' &&
    typeof manifestHash === 'string' &&
    /^[0-9a-f]{64}$/.test(manifestHash);
  if (!validFileHashes || !validChangelog) return false;

  if (marker.schema === 3) {
    return (
      marker.releaseNotesPath === undefined &&
      typeof marker.releaseNotesHash === 'string' &&
      validManifest
    );
  }

  return (
    typeof marker.releaseNotesPath === 'string' &&
    typeof legacyReleaseNotesHash === 'string' &&
    /^[0-9a-f]{64}$/.test(legacyReleaseNotesHash) &&
    marker.releaseNotesHash === undefined &&
    (marker.schema === 1 || validManifest)
  );
}

export function extractReleaseNotesFromPullRequestBody(body: string): string | null {
  const notes = body.match(RELEASE_NOTES_PATTERN)?.[1]?.trim();
  return notes ? `${notes}\n` : null;
}

export function buildPullRequestBody(
  marker: ReleaseMarker,
  releaseNotes: string,
  header = ':robot: I have created a release *beep* *boop*',
  footer = 'This PR was generated with [Gitea Release Please](https://github.com/kuddy-on/gitea-release-please-action).',
): string {
  return `${header.trim()}\n---\n\n${RELEASE_NOTES_START}\n${releaseNotes.trim()}\n${RELEASE_NOTES_END}\n\n---\n${footer.trim()}\n\n${serializeMarker(marker)}`;
}
