import type { ChangelogSection, IssueReference, ParsedChange } from './types.js';

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

function escapeRegularExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function extractReleaseNotesFromChangelog(
  changelog: string,
  version: string,
): string | null {
  const escapedVersion = escapeRegularExpression(version);
  const heading = new RegExp(
    `^##\\s+(?:\\[${escapedVersion}\\](?:\\([^\\r\\n]*\\))?|${escapedVersion})(?:\\s+\\([^\\r\\n]*\\))?\\s*$`,
    'm',
  );
  const match = heading.exec(changelog);
  if (!match) return null;
  const following = changelog.slice(match.index + match[0].length);
  const boundaries = [
    /^##\s+/m.exec(following)?.index,
    /^[ \t]*<!--\s*insertion marker\s*-->/im.exec(following)?.index,
    /^[ \t]*<a\s+(?:name|id)=["'][^"'\r\n]+["']\s*><\/a>[ \t]*\r?$/im.exec(
      following,
    )?.index,
  ].filter((index): index is number => index !== undefined);
  const boundary = boundaries.length > 0 ? Math.min(...boundaries) : following.length;
  const section = changelog
    .slice(match.index, match.index + match[0].length + boundary)
    .trim();
  return section ? `${section}\n` : null;
}

function escapeMarkdown(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/[[\]*_`<>]/g, '\\$&')
    .replace(/[\r\n]+/g, ' ');
}

function issueLabel(reference: IssueReference): string {
  const repository = reference.repository
    ? `${reference.owner ? `${reference.owner}/` : ''}${reference.repository}`
    : '';
  return `${repository}#${reference.number}`;
}

function issueUrl(
  reference: IssueReference,
  options: Pick<ReleaseMarkdownOptions, 'webUrl' | 'owner' | 'repo'>,
): string {
  const owner = reference.owner ?? options.owner;
  const repo = reference.repository ?? options.repo;
  return `${options.webUrl}/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${encodeURIComponent(reference.number)}`;
}

function normalizeIssueText(value: string, labels: string[]): string {
  const matchLabels = [...labels].sort((left, right) => right.length - left.length);
  const pattern = new RegExp(
    `(?<![\\w./-])(?:${matchLabels.map(escapeRegularExpression).join('|')})(?![\\w-])`,
    'g',
  );

  return value
    .replace(pattern, '')
    .replace(/\(\s*(?:(?:[,;/|&]|and|or|和|及|以及)\s*)*\)/gi, '')
    .replace(/\[\s*(?:(?:[,;/|&]|and|or|和|及|以及)\s*)*\]/gi, '')
    .replace(/\s+([,;.!?])/g, '$1')
    .replace(/([([])\s+/g, '$1')
    .replace(/\s+([)\]])/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .replace(/^[\s,;:()[\]]+|[\s,;:()[\]]+$/g, '');
}

function formatTextWithIssueReferences(
  value: string,
  references: IssueReference[] | undefined,
  options: Pick<ReleaseMarkdownOptions, 'webUrl' | 'owner' | 'repo'>,
): string {
  if (!references || references.length === 0) return escapeMarkdown(value);

  const byLabel = new Map(references.map((reference) => [issueLabel(reference), reference]));
  const labels = [...byLabel.keys()];
  const text = escapeMarkdown(normalizeIssueText(value, labels));
  const issueLinks = labels
    .map((label) => {
      const reference = byLabel.get(label);
      if (!reference) return '';
      return `([${escapeMarkdown(label)}](${issueUrl(reference, options)}))`;
    })
    .filter(Boolean);
  return [text, ...issueLinks].filter(Boolean).join(' ');
}

function changeLine(
  change: ParsedChange,
  includeCommitAuthors: boolean,
  options: Pick<ReleaseMarkdownOptions, 'webUrl' | 'owner' | 'repo'>,
): string {
  const scope = change.scope ? `**${escapeMarkdown(change.scope)}:** ` : '';
  const author = includeCommitAuthors && change.author
    ? ` (@${escapeMarkdown(change.author.replace(/^@/, ''))})`
    : '';
  const subject = formatTextWithIssueReferences(
    change.subject,
    change.issueReferences,
    options,
  );
  return `* ${scope}${subject}${author} ([${change.sha.slice(0, 7)}](${change.url}))`;
}

function sections(
  changes: ParsedChange[],
  changelogSections: ChangelogSection[],
  includeCommitAuthors: boolean,
  options: Pick<ReleaseMarkdownOptions, 'webUrl' | 'owner' | 'repo'>,
): string {
  const breaking = changes.filter(
    (change) => change.breaking && change.breakingNotes.length > 0,
  );
  const breakingSection = breaking.length === 0
    ? ''
    : `### ⚠ BREAKING CHANGES\n\n${breaking
        .flatMap((change) =>
          change.breakingNotes.map(
            (note) =>
              `* ${formatTextWithIssueReferences(note, change.issueReferences, options)} ([${change.sha.slice(0, 7)}](${change.url}))`,
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
      .map((change) => changeLine(change, includeCommitAuthors, options))
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
    options,
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
