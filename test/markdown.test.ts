import { describe, expect, it } from 'vitest';

import { generateReleaseMarkdown } from '../src/markdown.js';

describe('release markdown', () => {
  it('groups changes, prepends changelog history, and creates compare links', () => {
    const generated = generateReleaseMarkdown({
      version: '1.2.0',
      tagName: 'v1.2.0',
      previousTag: 'v1.1.0',
      date: '2026-07-14',
      webUrl: 'https://gitea.example',
      owner: 'acme',
      repo: 'demo',
      changelogSections: [
        { type: 'feat', section: 'Features' },
        { type: 'fix', section: 'Bug Fixes' },
      ],
      includeCommitAuthors: false,
      existingChangelog: '# Changelog\n\n## 1.1.0\n\nOld notes\n',
      changes: [
        {
          sha: '1234567890',
          url: 'https://gitea.example/acme/demo/commit/1234567890',
          type: 'feat',
          scope: 'api',
          subject: 'support [filters]',
          breaking: false,
          breakingNotes: [],
        },
        {
          sha: 'abcdef1234',
          url: 'https://gitea.example/acme/demo/commit/abcdef1234',
          type: 'fix',
          scope: null,
          subject: 'handle empty values',
          breaking: false,
          breakingNotes: [],
        },
      ],
    });

    expect(generated.changelog).toContain(
      '## [1.2.0](https://gitea.example/acme/demo/compare/v1.1.0...v1.2.0) (2026-07-14)',
    );
    expect(generated.changelog.indexOf('## [1.2.0]')).toBeLessThan(
      generated.changelog.indexOf('## 1.1.0'),
    );
    expect(generated.releaseNotes).toContain('### Features');
    expect(generated.releaseNotes).toContain('### Bug Fixes');
    expect(generated.releaseNotes).toContain('support \\[filters\\]');
    expect(generated.releaseNotes).toContain('**Full Changelog**: [v1.1.0...v1.2.0]');
  });

  it('uses a tag commit link for an initial release', () => {
    const generated = generateReleaseMarkdown({
      version: '0.1.0',
      tagName: 'v0.1.0',
      date: '2026-07-14',
      webUrl: 'https://gitea.example/root',
      owner: 'acme',
      repo: 'demo',
      changelogSections: [{ type: 'feat', section: 'Features' }],
      includeCommitAuthors: false,
      changes: [
        {
          sha: '1234567',
          url: 'https://gitea.example/root/acme/demo/commit/1234567',
          type: 'feat',
          scope: null,
          subject: 'first feature',
          breaking: false,
          breakingNotes: [],
        },
      ],
    });

    expect(generated.releaseNotes).toContain(
      'https://gitea.example/root/acme/demo/commits/v0.1.0',
    );
  });
});
