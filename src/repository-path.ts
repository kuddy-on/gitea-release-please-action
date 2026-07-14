export const ROOT_PROJECT_PATH = '.';

export function normalizePackagePath(value: string): string {
  const normalized = value.replace(/^\.\//, '').replace(/\/+$/, '');
  if (value === ROOT_PROJECT_PATH || normalized === '') return ROOT_PROJECT_PATH;
  if (
    normalized.startsWith('/') ||
    normalized.includes('\\') ||
    normalized.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    throw new Error(`path must be a repository-relative directory: ${value}`);
  }
  return normalized;
}

export function addPath(packagePath: string, filePath: string): string {
  return packagePath === ROOT_PROJECT_PATH ? filePath : `${packagePath}/${filePath}`;
}

export function pathContains(packagePath: string, filePath: string): boolean {
  return (
    packagePath === ROOT_PROJECT_PATH ||
    filePath === packagePath ||
    filePath.startsWith(`${packagePath}/`)
  );
}
