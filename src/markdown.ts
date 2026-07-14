import type { ChangelogSection, ParsedChange } from './types.js';

interface ReleaseMarkdownOptions {
  version: string;
  tagName: string;
  previousTag?: string;
  date: string;
  changes: ParsedChange[];
  webUrl: string;
  owner: string;
  repo: string;
  existingChangelog?: string;
  changelogSections: ChangelogSection[];
  includeCommitAuthors: boolean;
}

interface GeneratedMarkdown {
  changelog: string;
  releaseNotes: string;
}

function escapeMarkdown(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/[[\]*_`<>]/g, '\\$&')
    .replace(/[\r\n]+/g, ' ');
}

function changeLine(change: ParsedChange, includeCommitAuthors: boolean): string {
  const scope = change.scope ? `**${escapeMarkdown(change.scope)}:** ` : '';
  const author = includeCommitAuthors && change.author
    ? ` (@${escapeMarkdown(change.author.replace(/^@/, ''))})`
    : '';
  return `* ${scope}${escapeMarkdown(change.subject)}${author} ([${change.sha.slice(0, 7)}](${change.url}))`;
}

function sections(
  changes: ParsedChange[],
  changelogSections: ChangelogSection[],
  includeCommitAuthors: boolean,
): string {
  const breaking = changes.filter(
    (change) => change.breaking && change.breakingNotes.length > 0,
  );
  const breakingSection = breaking.length === 0
    ? ''
    : `### ⚠ BREAKING CHANGES\n\n${breaking
        .flatMap((change) =>
          change.breakingNotes.map(
            (note) => `* ${escapeMarkdown(note)} ([${change.sha.slice(0, 7)}](${change.url}))`,
          ),
        )
        .join('\n')}`;
  const grouped = changelogSections.map((group) => {
    if (group.hidden) return '';
    const matching = changes.filter(
      (change) => !change.hidden && change.type === group.type,
    );
    if (matching.length === 0) return '';
    return `### ${group.section}\n\n${matching
      .map((change) => changeLine(change, includeCommitAuthors))
      .join('\n')}`;
  })
    .filter(Boolean)
    .join('\n\n');
  return [breakingSection, grouped].filter(Boolean).join('\n\n');
}

function compareUrl(options: ReleaseMarkdownOptions): string {
  const repositoryUrl = `${options.webUrl}/${encodeURIComponent(options.owner)}/${encodeURIComponent(options.repo)}`;
  const encodedTag = encodeURIComponent(options.tagName);
  if (!options.previousTag) return `${repositoryUrl}/commits/${encodedTag}`;
  return `${repositoryUrl}/compare/${encodeURIComponent(options.previousTag)}...${encodedTag}`;
}

function appendExisting(section: string, existing?: string): string {
  const current = existing?.trim();
  if (!current) return `# Changelog\n\n${section}\n`;

  if (/^# Changelog\s*(?:\r?\n|$)/i.test(current)) {
    const withoutHeading = current.replace(/^# Changelog\s*(?:\r?\n)*/i, '');
    return `# Changelog\n\n${section}${withoutHeading ? `\n\n${withoutHeading}` : ''}\n`;
  }

  return `# Changelog\n\n${section}\n\n${current}\n`;
}

export function generateReleaseMarkdown(options: ReleaseMarkdownOptions): GeneratedMarkdown {
  const url = compareUrl(options);
  const groupedChanges = sections(
    options.changes,
    options.changelogSections,
    options.includeCommitAuthors,
  );
  const fullChangelog = `**Full Changelog**: [${
    options.previousTag ? `${options.previousTag}...${options.tagName}` : options.tagName
  }](${url})`;

  const releaseNotes = `## [${options.version}](${url}) (${options.date})\n\n${groupedChanges}\n\n${fullChangelog}\n`;
  const changelogSection = releaseNotes.trim();

  return {
    changelog: appendExisting(changelogSection, options.existingChangelog),
    releaseNotes,
  };
}
