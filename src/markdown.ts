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

function escapeRegularExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function linkIssueReferences(
  value: string,
  references: IssueReference[] | undefined,
  options: Pick<ReleaseMarkdownOptions, 'webUrl' | 'owner' | 'repo'>,
): string {
  if (!references || references.length === 0) return escapeMarkdown(value);

  const byLabel = new Map(references.map((reference) => [issueLabel(reference), reference]));
  const labels = [...byLabel.keys()];
  const matchLabels = [...labels].sort((left, right) => right.length - left.length);
  const pattern = new RegExp(
    `(?<![\\w./-])(?:${matchLabels.map(escapeRegularExpression).join('|')})(?![\\w-])`,
    'g',
  );
  const linked = new Set<string>();
  let result = '';
  let start = 0;

  for (const match of value.matchAll(pattern)) {
    const label = match[0];
    const index = match.index;
    const reference = byLabel.get(label);
    if (!reference) continue;
    result += escapeMarkdown(value.slice(start, index));
    result += `[${escapeMarkdown(label)}](${issueUrl(reference, options)})`;
    linked.add(label);
    start = index + label.length;
  }

  result += escapeMarkdown(value.slice(start));
  const unlinked = labels
    .filter((label) => !linked.has(label))
    .map((label) => {
      const reference = byLabel.get(label);
      if (!reference) return '';
      return `([${escapeMarkdown(label)}](${issueUrl(reference, options)}))`;
    })
    .filter(Boolean);
  return [result, ...unlinked].filter(Boolean).join(' ');
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
  const subject = linkIssueReferences(change.subject, change.issueReferences, options);
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
              `* ${linkIssueReferences(note, change.issueReferences, options)} ([${change.sha.slice(0, 7)}](${change.url}))`,
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
