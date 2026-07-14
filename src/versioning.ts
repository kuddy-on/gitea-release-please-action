import semver from 'semver';

import type {
  ActionConfig,
  ParsedChange,
  VersionBump,
  VersioningStrategy,
} from './types.js';

function newestReleaseAs(changes: ParsedChange[]): string | undefined {
  for (let index = changes.length - 1; index >= 0; index -= 1) {
    const releaseAs = changes[index]?.releaseAs;
    if (releaseAs) return releaseAs;
  }
  return undefined;
}

function conventionalBump(
  previousVersion: string,
  changes: ParsedChange[],
  config: Pick<ActionConfig, 'bumpMinorPreMajor' | 'bumpPatchForMinorPreMajor'>,
): VersionBump {
  const hasBreaking = changes.some((change) => change.breaking);
  const hasFeature = changes.some(
    (change) => !change.breaking && ['feat', 'feature'].includes(change.type),
  );
  const preMajor = semver.major(previousVersion) === 0;
  if (hasBreaking) return preMajor && config.bumpMinorPreMajor ? 'minor' : 'major';
  if (hasFeature) {
    return preMajor && config.bumpPatchForMinorPreMajor ? 'patch' : 'minor';
  }
  return 'patch';
}

function strategyBump(
  strategy: VersioningStrategy,
  previousVersion: string,
  changes: ParsedChange[],
  config: Pick<ActionConfig, 'bumpMinorPreMajor' | 'bumpPatchForMinorPreMajor'>,
): VersionBump {
  switch (strategy) {
    case 'always-bump-patch':
      return 'patch';
    case 'always-bump-minor':
      return 'minor';
    case 'always-bump-major':
      return 'major';
    case 'default':
    case 'prerelease':
      return conventionalBump(previousVersion, changes, config);
  }
}

function bumpPrerelease(value: string): string {
  const match = value.match(/\d+(?=\D*$)/);
  if (!match || match.index === undefined) return `${value}.1`;
  const next = String(Number(match[0]) + 1).padStart(match[0].length, '0');
  return `${value.slice(0, match.index)}${next}${value.slice(match.index + match[0].length)}`;
}

function prereleaseVersion(
  previousVersion: string,
  bump: VersionBump,
  prerelease: boolean,
  prereleaseType?: string,
): string {
  const current = semver.parse(previousVersion);
  if (!current) throw new Error(`Unable to parse version ${previousVersion}.`);
  const core = `${current.major}.${current.minor}.${current.patch}`;
  const nextCore = semver.inc(core, bump);
  if (!nextCore) throw new Error(`Unable to bump prerelease version ${previousVersion}.`);
  const currentPrerelease = current.prerelease.map(String).join('.');

  let candidate = nextCore;
  if (currentPrerelease !== '') {
    const staysOnCore =
      bump === 'patch' ||
      (bump === 'minor' && current.patch === 0) ||
      (bump === 'major' && current.minor === 0 && current.patch === 0);
    candidate = staysOnCore
      ? `${core}-${bumpPrerelease(currentPrerelease)}`
      : `${nextCore}-${currentPrerelease}`;
  } else if (prerelease && prereleaseType) {
    candidate = `${nextCore}-${prereleaseType}`;
  }

  return prerelease ? candidate : candidate.split('-')[0] ?? candidate;
}

export function calculateVersion(
  previousVersion: string | null,
  changes: ParsedChange[],
  config: Pick<
    ActionConfig,
    | 'initialVersion'
    | 'releaseAs'
    | 'versioningStrategy'
    | 'bumpMinorPreMajor'
    | 'bumpPatchForMinorPreMajor'
    | 'prereleaseType'
    | 'prerelease'
  >,
): string {
  const forced = config.releaseAs ?? newestReleaseAs(changes);
  if (forced) {
    const normalized = semver.valid(forced);
    if (!normalized) throw new Error(`Release-As must be a full SemVer: ${forced}`);
    return normalized;
  }
  if (!previousVersion) return config.initialVersion;

  const bump = strategyBump(
    config.versioningStrategy,
    previousVersion,
    changes,
    config,
  );
  if (config.versioningStrategy !== 'prerelease') {
    const next = semver.inc(previousVersion, bump);
    if (!next) throw new Error(`Unable to bump version ${previousVersion}.`);
    return next;
  }

  return prereleaseVersion(
    previousVersion,
    bump,
    config.prerelease,
    config.prereleaseType,
  );
}
