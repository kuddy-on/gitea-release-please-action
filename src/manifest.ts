import semver from 'semver';

import { normalizePackagePath } from './repository-path.js';

export type ReleaseManifest = Record<string, string>;

export function parseManifest(
  content: string,
  manifestPath: string,
): ReleaseManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new Error(`${manifestPath} contains invalid JSON.`, { cause: error });
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${manifestPath} must contain a JSON object.`);
  }

  const manifest = Object.create(null) as ReleaseManifest;
  for (const [path, version] of Object.entries(parsed)) {
    let normalizedPath: string;
    try {
      normalizedPath = normalizePackagePath(path);
    } catch (error) {
      throw new Error(`${manifestPath} contains invalid package path ${path}.`, {
        cause: error,
      });
    }
    if (normalizedPath !== path) {
      throw new Error(
        `${manifestPath} package path ${path} must be normalized as ${normalizedPath}.`,
      );
    }
    if (typeof version !== 'string' || semver.valid(version) !== version) {
      throw new Error(
        `${manifestPath} version for ${path} must be a full SemVer: ${String(version)}`,
      );
    }
    manifest[path] = version;
  }
  return manifest;
}

export function packageVersion(
  manifest: ReleaseManifest,
  packagePath: string,
  manifestPath: string,
): string | null {
  const paths = Object.keys(manifest);
  if (paths.length > 1) {
    throw new Error(`${manifestPath} contains multiple packages; exactly one is supported.`);
  }
  if (paths.length === 1 && paths[0] !== packagePath) {
    throw new Error(
      `${manifestPath} tracks ${paths[0]}, not configured package ${packagePath}.`,
    );
  }
  return manifest[packagePath] ?? null;
}

export function updateManifest(
  manifest: ReleaseManifest,
  packagePath: string,
  version: string,
): string {
  const entries = Object.entries(manifest).filter(([path]) => path !== packagePath);
  entries.push([packagePath, version]);
  return `${JSON.stringify(Object.fromEntries(entries), null, 2)}\n`;
}
