# 仓库指南

## 项目结构与模块组织

运行时代码位于 `src/`。`src/index.ts` 是 Action 入口，`release-manager.ts` 负责发布 PR、标签和 Release 生命周期，`gitea-client.ts` 封装 Gitea REST API。提交解析、Markdown、状态标记、配置和公共类型分别放在同级专用模块中。

单元测试位于 `test/`，文件名与源码模块对应，例如 `test/conventional.test.ts`。`action.yml` 定义公开的 Action 输入和输出；`dist/` 保存 Gitea Runner 实际执行的已提交 Node.js 包。使用示例位于 `examples/`，Docker 集成测试为 `scripts/integration-test.sh`，仓库自身 CI 位于 `.github/workflows/`。

## 构建、测试与开发命令

- `npm ci`：按锁文件安装 Node.js 24 依赖。
- `npm run lint`：使用 ESLint 检查代码和配置。
- `npm run typecheck`：执行严格 TypeScript 类型检查，不生成文件。
- `npm test`：运行全部 Vitest 单元测试。
- `npm run build`：使用 `ncc` 将 `src/index.ts` 打包到 `dist/`。
- `npm run check`：依次执行 lint、类型检查、单元测试和打包。
- `npm run test:integration`：使用临时 `gitea/gitea:1.27` 容器验证两轮完整发布；需要 Docker、`curl` 和 `jq`。

## 编码风格与命名规范

使用 ES Modules、两空格缩进、单引号和分号，并保持现有格式。不得弱化 `strict`、`noUncheckedIndexedAccess` 或 `exactOptionalPropertyTypes`。函数和变量使用 `camelCase`，类和类型使用 `PascalCase`，多单词模块文件名使用小写连字符。REST 交互集中在 `GiteaClient`，发布编排集中在 `ReleaseManager`。

## 测试规范

每项行为变更和缺陷修复都应在 `test/<module>.test.ts` 中增加针对性用例。单元测试应模拟 HTTP 交互；真实 Gitea 生命周期交给集成脚本验证。项目未设置覆盖率阈值，应覆盖所有受影响分支和失败路径。提交前运行 `npm run check`；修改 API、标签、PR 或 Release 行为时还必须运行集成测试。

## 提交与 Pull Request 规范

提交信息使用 Conventional Commits，例如 `feat(api): add dispatch support`、`fix: preserve release notes` 或 `refactor(client)!: change authentication`。这些分类会直接影响本项目生成的版本号和发布说明。

PR 应说明用户可见行为、关联问题和已执行的检查。输入、权限或输出发生变化时应同步示例。修改运行时代码后必须重新生成并提交 `dist/`；评审者应能在重新构建后通过 `git diff --exit-code -- dist` 验证产物一致。

## 安全与配置

禁止提交 Token 或临时凭据。优先使用具备最小 `permissions` 的 `${{ secrets.GITEA_TOKEN }}`；只有需要触发其他工作流时才授予 `actions: write`。
