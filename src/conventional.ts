import { CommitParser } from 'conventional-commits-parser';

import type {
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
  fix: 'patch',
  perf: 'patch',
  deps: 'patch',
};

const BUMP_RANK: Readonly<Record<VersionBump, number>> = {
  patch: 1,
  minor: 2,
  major: 3,
};

export function parseChanges(commits: RepositoryCommit[]): ParsedChange[] {
  const changes: ParsedChange[] = [];

  for (const commit of commits) {
    const parsed = parser.parse(commit.commit.message);
    const type = parsed.type?.toLowerCase() ?? null;
    const subject = parsed.subject;
    const breakingNotes = parsed.notes.map((note) => note.text.trim()).filter(Boolean);
    const breaking = parsed.breaking === '!' || breakingNotes.length > 0;

    if (!type || !subject || (!breaking && !(type in BUMP_BY_TYPE))) continue;

    changes.push({
      sha: commit.sha,
      url: commit.html_url,
      type,
      scope: parsed.scope || null,
      subject: subject.trim(),
      breaking,
      breakingNotes,
    });
  }

  return changes;
}

export function requiredBump(changes: ParsedChange[]): VersionBump | null {
  let selected: VersionBump | null = null;

  for (const change of changes) {
    const candidate = change.breaking ? 'major' : BUMP_BY_TYPE[change.type];
    if (!candidate) continue;
    if (!selected || BUMP_RANK[candidate] > BUMP_RANK[selected]) selected = candidate;
  }

  return selected;
}
