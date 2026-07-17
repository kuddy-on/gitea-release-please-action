import { createHash } from 'node:crypto';

import type { ReleaseMarker } from './types.js';

const MARKER_PATTERN = /<!--\s*gitea-release-please:\s*(\{[^\r\n]*\})\s*-->/;

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
    (marker.schema !== 1 && marker.schema !== 2) ||
    (marker.path !== undefined && typeof marker.path !== 'string') ||
    typeof marker.version !== 'string' ||
    typeof marker.tagName !== 'string' ||
    typeof marker.targetBranch !== 'string' ||
    (marker.targetHeadSha !== undefined &&
      (typeof marker.targetHeadSha !== 'string' ||
        !/^[0-9a-f]{7,64}$/.test(marker.targetHeadSha))) ||
    (marker.changelogPath !== undefined && typeof marker.changelogPath !== 'string') ||
    typeof marker.releaseNotesPath !== 'string' ||
    (marker.manifestPath !== undefined && typeof marker.manifestPath !== 'string') ||
    !fileHashes ||
    typeof fileHashes !== 'object'
  ) {
    return false;
  }
  const changelogHash = marker.changelogPath
    ? fileHashes[marker.changelogPath]
    : undefined;
  const releaseNotesHash = fileHashes[marker.releaseNotesPath];
  const manifestHash = marker.manifestPath
    ? fileHashes[marker.manifestPath]
    : undefined;
  return (
    Object.entries(fileHashes).every(
      ([path, hash]) => path !== '' && typeof hash === 'string' && /^[0-9a-f]{64}$/.test(hash),
    ) &&
    (marker.changelogPath === undefined ||
      (typeof changelogHash === 'string' && /^[0-9a-f]{64}$/.test(changelogHash))) &&
    typeof releaseNotesHash === 'string' &&
    /^[0-9a-f]{64}$/.test(releaseNotesHash) &&
    (marker.schema === 1 ||
      (typeof marker.manifestPath === 'string' &&
        typeof manifestHash === 'string' &&
        /^[0-9a-f]{64}$/.test(manifestHash)))
  );
}

export function buildPullRequestBody(
  marker: ReleaseMarker,
  releaseNotes: string,
  header = ':robot: I have created a release *beep* *boop*',
  footer = 'This PR was generated with [Gitea Release Please](https://github.com/kuddy-on/gitea-release-please-action).',
): string {
  return `${header.trim()}\n---\n\n${releaseNotes.trim()}\n\n---\n${footer.trim()}\n\n${serializeMarker(marker)}`;
}
