import { describe, expect, it } from 'vitest';

import {
  extractReleaseNotesFromChangelog,
  generateReleaseMarkdown,
} from '../src/markdown.js';

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

  it('extracts one version section from a cumulative changelog', () => {
    const changelog =
      '# Changelog\n\n' +
      '## [1.2.0](https://gitea.example/compare/v1.1.0...v1.2.0) (2026-07-14)\n\n' +
      '### Features\n\n* current\n\n' +
      '## 1.1.0\n\n* previous\n';

    expect(extractReleaseNotesFromChangelog(changelog, '1.2.0')).toBe(
      '## [1.2.0](https://gitea.example/compare/v1.1.0...v1.2.0) (2026-07-14)\n\n' +
        '### Features\n\n* current\n',
    );
    expect(extractReleaseNotesFromChangelog(changelog, '1.1.0')).toBe(
      '## 1.1.0\n\n* previous\n',
    );
    expect(extractReleaseNotesFromChangelog(changelog, '9.9.9')).toBeNull();
  });

  it('excludes legacy insertion markers and version anchors from release notes', () => {
    const generated = generateReleaseMarkdown({
      version: '6.0.0',
      tagName: 'v6.0.0',
      previousTag: 'v5.0.1',
      date: '2026-07-18',
      webUrl: 'https://gitea.example',
      owner: 'acme',
      repo: 'demo',
      changelogSections: [{ type: 'feat', section: 'Features' }],
      includeCommitAuthors: false,
      existingChangelog:
        '# Changelog\n\n' +
        '<!-- insertion marker -->\n' +
        '<a name="5.0.1"></a>\n' +
        '## [5.0.1](https://gitea.example/acme/demo/releases/tag/v5.0.1)\n\n' +
        '* previous release\n',
      changes: [
        {
          sha: '1234567890',
          url: 'https://gitea.example/acme/demo/commit/1234567890',
          type: 'feat',
          scope: null,
          subject: 'new feature',
          breaking: false,
          breakingNotes: [],
        },
      ],
    });

    expect(extractReleaseNotesFromChangelog(generated.changelog, '6.0.0')).toBe(
      generated.releaseNotes,
    );
    expect(
      extractReleaseNotesFromChangelog(
        generated.changelog.replace('<!-- insertion marker -->\n', ''),
        '6.0.0',
      ),
    ).toBe(generated.releaseNotes);
  });

  it('normalizes issue references after titles and before authors and commits', () => {
    const generated = generateReleaseMarkdown({
      version: '1.2.1',
      tagName: 'v1.2.1',
      previousTag: 'v1.2.0',
      date: '2026-07-17',
      webUrl: 'https://gitea.example',
      owner: 'acme',
      repo: 'demo',
      changelogSections: [{ type: 'fix', section: 'Bug Fixes' }],
      includeCommitAuthors: true,
      changes: [
        {
          sha: '1234567890',
          url: 'https://gitea.example/acme/demo/commit/1234567890',
          type: 'fix',
          scope: 'api',
          subject: '(#12) repair cache',
          breaking: false,
          breakingNotes: [],
          author: '@alice',
          issueReferences: [
            { number: '12' },
            { number: '34', owner: 'other', repository: 'service' },
          ],
        },
        {
          sha: 'abcdef1234',
          url: 'https://gitea.example/acme/demo/commit/abcdef1234',
          type: 'fix',
          scope: null,
          subject: 'repair queue (#13, #15)',
          breaking: false,
          breakingNotes: [],
          issueReferences: [{ number: '13' }, { number: '15' }],
        },
        {
          sha: 'fedcba9876',
          url: 'https://gitea.example/acme/demo/commit/fedcba9876',
          type: 'fix',
          scope: null,
          subject: 'repair #14 worker',
          breaking: false,
          breakingNotes: [],
          issueReferences: [{ number: '14' }],
        },
      ],
    });

    expect(generated.releaseNotes).toContain(
      '* **api:** repair cache ' +
        '([#12](https://gitea.example/acme/demo/issues/12)) ' +
        '([other/service#34](https://gitea.example/other/service/issues/34)) ' +
        '(@alice) ' +
        '([1234567](https://gitea.example/acme/demo/commit/1234567890))',
    );
    expect(generated.releaseNotes).toContain(
      '* repair queue ([#13](https://gitea.example/acme/demo/issues/13)) ' +
        '([#15](https://gitea.example/acme/demo/issues/15)) ' +
        '([abcdef1](https://gitea.example/acme/demo/commit/abcdef1234))',
    );
    expect(generated.releaseNotes).toContain(
      '* repair worker ([#14](https://gitea.example/acme/demo/issues/14)) ' +
        '([fedcba9](https://gitea.example/acme/demo/commit/fedcba9876))',
    );
  });
});
