import type { ParsedChange } from './types.js';

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
}

interface GeneratedMarkdown {
  changelog: string;
  releaseNotes: string;
}

const GROUPS = [
  { title: 'Breaking Changes', match: (change: ParsedChange) => change.breaking },
  {
    title: 'Features',
    match: (change: ParsedChange) => !change.breaking && change.type === 'feat',
  },
  {
    title: 'Bug Fixes',
    match: (change: ParsedChange) => !change.breaking && change.type === 'fix',
  },
  {
    title: 'Performance',
    match: (change: ParsedChange) => !change.breaking && change.type === 'perf',
  },
  {
    title: 'Dependencies',
    match: (change: ParsedChange) => !change.breaking && change.type === 'deps',
  },
] as const;

function escapeMarkdown(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/[[\]*_`<>]/g, '\\$&')
    .replace(/[\r\n]+/g, ' ');
}

function changeLine(change: ParsedChange): string {
  const scope = change.scope ? `**${escapeMarkdown(change.scope)}:** ` : '';
  const note =
    change.breakingNotes.length > 0
      ? ` — ${escapeMarkdown(change.breakingNotes.join('; '))}`
      : '';
  return `- ${scope}${escapeMarkdown(change.subject)}${note} ([${change.sha.slice(0, 7)}](${change.url}))`;
}

function sections(changes: ParsedChange[]): string {
  return GROUPS.map((group) => {
    const matching = changes.filter(group.match);
    if (matching.length === 0) return '';
    return `### ${group.title}\n\n${matching.map(changeLine).join('\n')}`;
  })
    .filter(Boolean)
    .join('\n\n');
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
  const groupedChanges = sections(options.changes);
  const fullChangelog = `**Full Changelog**: [${
    options.previousTag ? `${options.previousTag}...${options.tagName}` : options.tagName
  }](${url})`;

  const releaseNotes = `# ${options.tagName} (${options.date})\n\n${groupedChanges}\n\n${fullChangelog}\n`;
  const changelogSection = `## [${options.version}](${url}) (${options.date})\n\n${groupedChanges}`;

  return {
    changelog: appendExisting(changelogSection, options.existingChangelog),
    releaseNotes,
  };
}
