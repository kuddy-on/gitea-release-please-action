import * as toml from '@iarna/toml';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import { dump as dumpYaml, loadAll as loadAllYaml } from 'js-yaml';
import { JSONPath } from 'jsonpath-plus';
import * as xpath from 'xpath';

import type { ExtraFile } from './types.js';

const VERSION_PATTERN = /\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?/;
const INLINE_MARKER =
  /x-release-please-(version-date|major|minor|patch|version|date)\b/;
const BLOCK_START_MARKER =
  /x-release-please-start-(version-date|major|minor|patch|version|date)\b/;
const BLOCK_END_MARKER = /x-release-please-end\b/;
const MAX_EXTRA_FILES = 100;

type GenericScope = 'major' | 'minor' | 'patch' | 'version' | 'date' | 'version-date';
type JsonContainer = Record<string, unknown> | unknown[];

interface PointerTarget {
  parent: JsonContainer;
  key: string | number;
  value: unknown;
}

interface GenericReplacement {
  line: string;
  matches: number;
}

function repositoryPath(value: unknown, location: string): string {
  if (typeof value !== 'string') {
    throw new Error(`${location}.path must be a string.`);
  }
  const normalized = value.replace(/^\.\//, '');
  if (
    normalized === '' ||
    normalized.startsWith('/') ||
    normalized.includes('\\') ||
    normalized.split('/').includes('..')
  ) {
    throw new Error(`${location}.path must be a repository-relative path.`);
  }
  return normalized;
}

function selector(
  value: unknown,
  name: 'jsonpath' | 'xpath',
  location: string,
): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${location}.${name} must be a non-empty string.`);
  }
  const normalized = value.trim();
  if (name === 'jsonpath' && !normalized.startsWith('$')) {
    throw new Error(`${location}.jsonpath must start with $.`);
  }
  return normalized;
}

function parseExtraFile(value: unknown, index: number): ExtraFile {
  const location = `extra-files[${index}]`;
  if (typeof value === 'string') {
    return { type: 'generic', path: repositoryPath(value, location) };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${location} must be a path string or configuration object.`);
  }

  const entry = value as Record<string, unknown>;
  if (entry.glob !== undefined && typeof entry.glob !== 'boolean') {
    throw new Error(`${location}.glob must be true or false.`);
  }
  const glob = entry.glob === true ? true : undefined;
  const path = repositoryPath(entry.path, location);
  switch (entry.type) {
    case 'generic':
      return { type: 'generic', path, ...(glob ? { glob } : {}) };
    case 'json':
      return { type: 'json', path, jsonpath: selector(entry.jsonpath, 'jsonpath', location), ...(glob ? { glob } : {}) };
    case 'toml':
      return { type: 'toml', path, jsonpath: selector(entry.jsonpath, 'jsonpath', location), ...(glob ? { glob } : {}) };
    case 'yaml':
      return { type: 'yaml', path, jsonpath: selector(entry.jsonpath, 'jsonpath', location), ...(glob ? { glob } : {}) };
    case 'xml':
      return { type: 'xml', path, xpath: selector(entry.xpath, 'xpath', location), ...(glob ? { glob } : {}) };
    default:
      throw new Error(`${location}.type must be generic, json, toml, yaml, or xml.`);
  }
}

function globExpression(pattern: string): RegExp {
  let expression = '^';
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index] ?? '';
    if (character === '*') {
      if (pattern[index + 1] === '*') {
        index += 1;
        if (pattern[index + 1] === '/') {
          index += 1;
          expression += '(?:.*/)?';
        } else {
          expression += '.*';
        }
      } else {
        expression += '[^/]*';
      }
    } else if (character === '?') {
      expression += '[^/]';
    } else {
      expression += character.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
    }
  }
  return new RegExp(`${expression}$`);
}

export function expandExtraFiles(configured: ExtraFile[], paths: string[]): ExtraFile[] {
  const expanded: ExtraFile[] = [];
  for (const file of configured) {
    if (!file.glob) {
      expanded.push(file);
      continue;
    }
    const matcher = globExpression(file.path);
    const matches = paths.filter((path) => matcher.test(path));
    if (matches.length === 0) {
      throw new Error(`extra-files glob ${file.path} matched no repository files.`);
    }
    for (const path of matches) {
      expanded.push({ ...file, path, glob: false });
    }
  }
  const unique = new Set<string>();
  for (const file of expanded) {
    if (unique.has(file.path)) {
      throw new Error(`extra-files resolves duplicate path ${file.path}.`);
    }
    unique.add(file.path);
  }
  return expanded;
}

export function parseExtraFiles(raw: string | undefined): ExtraFile[] {
  if (raw === undefined) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error('extra-files must be a valid JSON array.', { cause: error });
  }
  if (!Array.isArray(parsed)) throw new Error('extra-files must be a JSON array.');
  if (parsed.length > MAX_EXTRA_FILES) {
    throw new Error(`extra-files cannot contain more than ${MAX_EXTRA_FILES} entries.`);
  }

  const extraFiles = parsed.map(parseExtraFile);
  const paths = new Set<string>();
  for (const extraFile of extraFiles) {
    if (paths.has(extraFile.path)) {
      throw new Error(`extra-files contains duplicate path ${extraFile.path}.`);
    }
    paths.add(extraFile.path);
  }
  return extraFiles;
}

function isContainer(value: unknown): value is JsonContainer {
  return Array.isArray(value) || (value !== null && typeof value === 'object');
}

function decodePointerSegment(value: string): string {
  return value.replace(/~1/g, '/').replace(/~0/g, '~');
}

function pointerTarget(root: unknown, pointer: string, file: ExtraFile): PointerTarget {
  if (pointer === '') {
    throw new Error(`extra-files selector for ${file.path} cannot target the document root.`);
  }
  const segments = pointer.split('/').slice(1).map(decodePointerSegment);
  const finalSegment = segments.pop();
  if (finalSegment === undefined) {
    throw new Error(`extra-files selector for ${file.path} returned an invalid pointer.`);
  }

  let current = root;
  for (const segment of segments) {
    if (!isContainer(current)) {
      throw new Error(`extra-files selector for ${file.path} traversed a scalar value.`);
    }
    const key = Array.isArray(current) ? Number(segment) : segment;
    if (Array.isArray(current) && !Number.isInteger(key)) {
      throw new Error(`extra-files selector for ${file.path} returned an invalid array index.`);
    }
    current = current[key as keyof typeof current];
  }
  if (!isContainer(current)) {
    throw new Error(`extra-files selector for ${file.path} did not return a property.`);
  }

  const key = Array.isArray(current) ? Number(finalSegment) : finalSegment;
  if (Array.isArray(current) && !Number.isInteger(key)) {
    throw new Error(`extra-files selector for ${file.path} returned an invalid array index.`);
  }
  return {
    parent: current,
    key,
    value: current[key as keyof typeof current],
  };
}

function selectedTargets(root: unknown, path: string, file: ExtraFile): PointerTarget[] {
  let pointers: string[];
  try {
    pointers = JSONPath<string[]>({ path, json: root as object, resultType: 'pointer', eval: false });
  } catch (error) {
    throw new Error(`Invalid JSONPath ${path} for extra file ${file.path}.`, { cause: error });
  }
  const uniquePointers = [...new Set(pointers)];
  if (uniquePointers.length === 0) {
    throw new Error(`JSONPath ${path} matched no values in extra file ${file.path}.`);
  }
  return uniquePointers.map((pointer) => pointerTarget(root, pointer, file));
}

function setTarget(target: PointerTarget, value: string): void {
  if (Array.isArray(target.parent)) target.parent[target.key as number] = value;
  else target.parent[target.key as string] = value;
}

function updateStructuredTargets(
  root: unknown,
  path: string,
  file: ExtraFile,
  version: string,
  replaceEmbeddedVersion: boolean,
): void {
  for (const target of selectedTargets(root, path, file)) {
    if (typeof target.value !== 'string') {
      throw new Error(`JSONPath ${path} in extra file ${file.path} must select strings.`);
    }
    if (replaceEmbeddedVersion) {
      if (!VERSION_PATTERN.test(target.value)) {
        throw new Error(`JSONPath ${path} in extra file ${file.path} contains no SemVer value.`);
      }
      setTarget(target, target.value.replace(VERSION_PATTERN, version));
    } else {
      setTarget(target, version);
    }
  }
}

function jsonIndent(content: string): string | number {
  if (!content.includes('\n')) return 0;
  return content.match(/^[\t ]+(?=\S)/m)?.[0] ?? '  ';
}

function updateJson(file: Extract<ExtraFile, { type: 'json' }>, content: string, version: string) {
  let data: unknown;
  try {
    data = JSON.parse(content);
  } catch (error) {
    throw new Error(`Extra file ${file.path} contains invalid JSON.`, { cause: error });
  }
  updateStructuredTargets(data, file.jsonpath, file, version, true);
  return `${JSON.stringify(data, null, jsonIndent(content))}${content.endsWith('\n') ? '\n' : ''}`;
}

function updateToml(file: Extract<ExtraFile, { type: 'toml' }>, content: string, version: string) {
  let data: ReturnType<typeof toml.parse>;
  try {
    data = toml.parse(content);
  } catch (error) {
    throw new Error(`Extra file ${file.path} contains invalid TOML.`, { cause: error });
  }
  updateStructuredTargets(data, file.jsonpath, file, version, false);
  return toml.stringify(data);
}

function updateYaml(file: Extract<ExtraFile, { type: 'yaml' }>, content: string, version: string) {
  let documents: unknown[];
  try {
    documents = loadAllYaml(content, { json: true });
  } catch (error) {
    throw new Error(`Extra file ${file.path} contains invalid YAML.`, { cause: error });
  }
  if (documents.length === 0) throw new Error(`Extra file ${file.path} contains no YAML document.`);

  let matched = false;
  for (const document of documents) {
    try {
      updateStructuredTargets(document, file.jsonpath, file, version, false);
      matched = true;
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes('matched no values')) throw error;
    }
  }
  if (!matched) {
    throw new Error(`JSONPath ${file.jsonpath} matched no values in extra file ${file.path}.`);
  }

  const dumped = documents.map((document) => dumpYaml(document, { noRefs: true, lineWidth: -1 }));
  if (documents.length > 1) return dumped.map((document) => `---\n${document}`).join('');
  return content.trimStart().startsWith('---') ? `---\n${dumped[0]}` : (dumped[0] ?? '');
}

function updateXml(file: Extract<ExtraFile, { type: 'xml' }>, content: string, version: string) {
  let document: ReturnType<DOMParser['parseFromString']>;
  try {
    document = new DOMParser({
      onError(level, message) {
        if (level !== 'warning') throw new Error(message);
      },
    }).parseFromString(content, 'text/xml');
  } catch (error) {
    throw new Error(`Extra file ${file.path} contains invalid XML.`, { cause: error });
  }

  let selected: xpath.SelectReturnType;
  try {
    selected = xpath.select(file.xpath, document as unknown as Node);
  } catch (error) {
    throw new Error(`Invalid XPath ${file.xpath} for extra file ${file.path}.`, { cause: error });
  }
  const values = Array.isArray(selected) ? selected : [selected];
  const nodes = values.filter(xpath.isNodeLike);
  if (nodes.length === 0) {
    throw new Error(`XPath ${file.xpath} matched no nodes in extra file ${file.path}.`);
  }
  for (const node of nodes) node.textContent = version;

  const serialized = new XMLSerializer().serializeToString(document);
  return content.endsWith('\n') && !serialized.endsWith('\n') ? `${serialized}\n` : serialized;
}

function replaceScope(
  line: string,
  scope: GenericScope,
  version: string,
  date: string,
  dateFormat: string,
): GenericReplacement {
  const [major, minor, patch] = version.split('.');
  if (!major || !minor || !patch) throw new Error(`Invalid release version ${version}.`);

  if (scope === 'version') {
    return VERSION_PATTERN.test(line)
      ? { line: line.replace(VERSION_PATTERN, version), matches: 1 }
      : { line, matches: 0 };
  }
  if (scope === 'date') {
    const pattern = datePattern(dateFormat);
    return pattern.test(line)
      ? { line: line.replace(pattern, date), matches: 1 }
      : { line, matches: 0 };
  }
  if (scope === 'version-date') {
    const versionResult = replaceScope(line, 'version', version, date, dateFormat);
    const dateResult = replaceScope(
      versionResult.line,
      'date',
      version,
      date,
      dateFormat,
    );
    return { line: dateResult.line, matches: versionResult.matches + dateResult.matches };
  }

  const replacement = scope === 'major' ? major : scope === 'minor' ? minor : patch;
  const integerPattern = /\b\d+\b/;
  return integerPattern.test(line)
    ? { line: line.replace(integerPattern, replacement), matches: 1 }
    : { line, matches: 0 };
}

function datePattern(format: string): RegExp {
  const expression = format
    .replace(/[|\\{}()[\]^$+*?.-]/g, '\\$&')
    .replace(/%Y/g, '\\d{4}')
    .replace(/%m/g, '\\d{2}')
    .replace(/%d/g, '\\d{2}')
    .replace(/%F/g, '\\d{4}\\-\\d{2}\\-\\d{2}');
  return new RegExp(expression);
}

function updateGeneric(
  file: Extract<ExtraFile, { type: 'generic' }>,
  content: string,
  version: string,
  date: string,
  dateFormat: string,
): string {
  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  const lines = content.split(/\r?\n/);
  const output: string[] = [];
  let blockScope: GenericScope | undefined;
  let blockMatches = 0;
  let markerCount = 0;

  for (const line of lines) {
    const inline = line.match(INLINE_MARKER);
    if (inline?.[1]) {
      markerCount += 1;
      const scope = inline[1] as GenericScope;
      const updated = replaceScope(line, scope, version, date, dateFormat);
      const expectedMatches = scope === 'version-date' ? 2 : 1;
      if (updated.matches !== expectedMatches) {
        throw new Error(`Version marker in extra file ${file.path} has no matching value.`);
      }
      output.push(updated.line);
      continue;
    }

    if (blockScope) {
      const updated = replaceScope(line, blockScope, version, date, dateFormat);
      blockMatches += updated.matches;
      output.push(updated.line);
      if (BLOCK_END_MARKER.test(line)) {
        if (blockMatches === 0) {
          throw new Error(`Version marker block in extra file ${file.path} has no matching value.`);
        }
        blockScope = undefined;
        blockMatches = 0;
      }
      continue;
    }

    const blockStart = line.match(BLOCK_START_MARKER);
    if (blockStart?.[1]) {
      markerCount += 1;
      blockScope = blockStart[1] as GenericScope;
    }
    output.push(line);
  }

  if (blockScope) throw new Error(`Version marker block in extra file ${file.path} is not closed.`);
  if (markerCount === 0) {
    throw new Error(`Extra file ${file.path} contains no x-release-please version markers.`);
  }
  return output.join(eol);
}

export function updateExtraFile(
  file: ExtraFile,
  content: string,
  version: string,
  date: string,
  dateFormat = '%Y-%m-%d',
): string {
  switch (file.type) {
    case 'generic':
      return updateGeneric(file, content, version, date, dateFormat);
    case 'json':
      return updateJson(file, content, version);
    case 'toml':
      return updateToml(file, content, version);
    case 'yaml':
      return updateYaml(file, content, version);
    case 'xml':
      return updateXml(file, content, version);
  }
}
