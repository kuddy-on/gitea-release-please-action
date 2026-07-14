import { CommitParser } from 'conventional-commits-parser';

import type {
  ChangelogSection,
  ParsedChange,
  RepositoryCommit,
  VersionBump,
} from './types.js';

const parser = new CommitParser({
  headerPattern: /^(\w[\w-]*)(?:\(([^)]+)\))?(!)?:\s+(.+)$/,
  headerCorrespondence: ['type', 'scope', 'breaking', 'subject'],
  noteKeywords: ['BREAKING CHANGE', 'BREAKING-CHANGE'],
});

const BUMP_BY_TYPE: Readonly<Record<string, VersionBump>> = {
  feat: 'minor',
  feature: 'minor',
  fix: 'patch',
  perf: 'patch',
  deps: 'patch',
  revert: 'patch',
};

const BUMP_RANK: Readonly<Record<VersionBump, number>> = {
  patch: 1,
  minor: 2,
  major: 3,
};

export function parseChanges(
  commits: RepositoryCommit[],
  changelogSections?: ChangelogSection[],
): ParsedChange[] {
  const changes: ParsedChange[] = [];

  for (const commit of commits) {
    const parsed = parser.parse(commit.commit.message);
    const type = parsed.type?.toLowerCase() ?? null;
    const subject = parsed.subject;
    const breakingNotes = parsed.notes.map((note) => note.text.trim()).filter(Boolean);
    const breaking = parsed.breaking === '!' || breakingNotes.length > 0;
    const releaseAsMatch = commit.commit.message.match(/^Release-As:\s*(\S+)\s*$/im);
    const releaseAs = releaseAsMatch?.[1];
    const configuredSection = changelogSections?.find(
      (section) => section.type.toLowerCase() === type,
    );
    const hidden = configuredSection?.hidden === true;

    if (!type || !subject) continue;
    if (
      !breaking &&
      !releaseAs &&
      !(type in BUMP_BY_TYPE) &&
      (!configuredSection || hidden)
    ) {
      continue;
    }

    const author = commit.author?.username ?? commit.author?.full_name;

    const change: ParsedChange = {
      sha: commit.sha,
      url: commit.html_url,
      type,
      scope: parsed.scope || null,
      subject: subject.trim(),
      breaking,
      breakingNotes,
    };
    if (hidden) change.hidden = true;
    if (releaseAs) change.releaseAs = releaseAs;
    if (author) change.author = author;
    changes.push(change);
  }

  return changes;
}

export function requiredBump(changes: ParsedChange[]): VersionBump | null {
  let selected: VersionBump | null = null;

  for (const change of changes) {
    const candidate = change.breaking
      ? 'major'
      : BUMP_BY_TYPE[change.type] ?? (change.hidden ? undefined : 'patch');
    if (!candidate) continue;
    if (!selected || BUMP_RANK[candidate] > BUMP_RANK[selected]) selected = candidate;
  }

  return selected;
}
