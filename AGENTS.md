# Repository Guidelines

## Project Structure & Module Organization

Runtime code lives in `src/`. `src/index.ts` is the single action entry point and `gitea-client.ts` wraps the Gitea REST API. Keep release-PR orchestration in `ReleaseManager` and post-merge tag/Release orchestration in `PublishManager`; manifest parsing, Conventional Commit parsing, versioning, Markdown generation, markers, configuration, and shared types belong in focused sibling modules.

Unit tests live in `test/` and mirror source modules, for example `test/conventional.test.ts`. `action.yml` defines the public interface, and the committed runner-ready bundle is stored in `dist/`. Usage examples are in `examples/`; the Docker lifecycle test is `scripts/integration-test.sh`; repository CI is under `.github/workflows/`.

## Build, Test, and Development Commands

- `npm ci`: install the exact Node.js 24 dependency set.
- `npm run lint`: check source and configuration with ESLint.
- `npm run typecheck`: run strict TypeScript checks without emitting files.
- `npm test`: run all Vitest unit tests.
- `npm run build`: bundle the Node action entry point into `dist/` with `ncc`.
- `npm run check`: run linting, type checks, unit tests, and bundling.
- `npm run test:integration`: verify release lifecycles, merge methods, package paths, and fork branches against temporary `gitea/gitea:1.27`; Docker, `curl`, and `jq` are required.

## Coding Style & Naming Conventions

Use ES Modules, two-space indentation, single quotes, and semicolons. Preserve `strict`, `noUncheckedIndexedAccess`, and `exactOptionalPropertyTypes`. Use `camelCase` for functions and variables, `PascalCase` for classes and types, and lowercase kebab-case for multiword module filenames. Keep REST calls in `GiteaClient`, release-PR preparation in `ReleaseManager`, and post-merge publication in `PublishManager`.

## Testing Guidelines

Add focused cases to `test/<module>.test.ts` for every behavior change or fix. Mock HTTP behavior in unit tests; use the Docker script for tag, PR, API, or Release lifecycle changes. No coverage threshold is configured, but all affected branches and failure paths should be exercised. Run `npm run check` before submitting.

## Commit & Pull Request Guidelines

Use Conventional Commits, such as `feat(api): add dispatch support`, `fix: preserve release notes`, or `refactor(client)!: change authentication`. PRs should explain user-visible behavior, link relevant issues, and list verification performed. Update examples when inputs, outputs, or permissions change. Runtime changes must include the regenerated bundle; verify it with `npm run build` and `git diff --exit-code -- dist`.

## Security & Configuration

Never commit tokens or temporary credentials. Prefer `${{ secrets.GITEA_TOKEN }}` with minimal permissions; grant `actions: write` only when dispatching another workflow.
