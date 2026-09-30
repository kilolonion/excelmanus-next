# 依赖复用检查与修复

日期：2026-09-30。环境：macOS Apple Silicon、Node 24.1.0、pnpm 10.11.0。

范围：仅 Web 的 DOMPurify 消毒与官方 React SWC 插件接入、依赖许可检查。保留并行 M2a 工作树，不代表 M1/M2 完整验收。决定见 [ADR 0008](../decisions/0008-permissive-dependency-reuse.md)。

## 实施结果

- DOMPurify 3.4.15 按 Apache-2.0 分支直接使用，删除原自写递归 HTML 消毒器；区域引用转换前后均消毒。
- 官方 React SWC 插件 4.3.3 接入 Vite 7；SWC core 精确锁定 1.16.2。恢复插件提供的 Fast Refresh 能力，实际交互未验收。
- SPDX 解析库安装后，其传递依赖 CC-BY-3.0 被许可证门禁拒绝；撤回试验依赖和门禁解析器替换。许可白名单、黑名单、例外与 peer 策略保持原样。
- 原验收报告补充更正链接，不改写历史报告为当前验收通过。

## 已执行与证据边界

| 检查 | 结果与范围 |
| --- | --- |
| 注册表元数据与发布时间 | 已查 `npm view`；直接依赖选择发布超过七天的精确版本 |
| Web 类型检查 | 最终消毒实现完成后通过 `pnpm --filter @excelmanus/web typecheck` |
| 许可证检查 | 最终依赖树通过 `pnpm check:licenses`；输出依赖数量见命令输出 |
| 变更文件 Biome | 通过；仅本次 Web 与门禁用例文件 |
| 依赖方向 | 检查中通过，202 modules / 362 dependencies；并行代码持续变化，非整个工作树冻结验收 |
| Web 生产构建 | 中间实现通过；证据 `/tmp/excelmanus-next-dependency-reuse-build.log`（临时路径不承诺长期保留）。最终消毒调整后未重跑 |
| gates/web 纯逻辑测试 | 中间版本 24 passed / 3 files；撤回 SPDX 期间另一次失败因解析器残留引用，已移除。最终版本未重新运行，不声明最终测试通过 |
| 全仓 `pnpm check:all` | 被并行 `packages/kernel/src/backup.ts` 的不可擦除 TS 参数属性阻断；全仓 lint 亦有并行文件格式/导入错误。未修改这些并行文件 |
| 浏览器 | 停止前只验证过中间实现的正常 Markdown/区域链接与一条 img 危险输入；六组完整验证未完成。初次 DOM 节点输出方案抛错，已改为字符串消毒与标准 DOMParser。负责人要求“不用实机验证”，随后停止浏览器、实机和后端运行验证 |

没有完成的项不标记通过。最终方案仅以源码与静态检查结果交付；实际 Fast Refresh、最终浏览器安全用例、HTTP/WS/SQLite 纵切、跨平台构建和桌面打包均未验收。

## 留待负责人审批的许可阻断

| 依赖 | 用途 | 当前阻断 |
| --- | --- | --- |
| lightningcss（连带 Vite 8、Tailwind 4 常用构建链） | CSS 转换、压缩、浏览器兼容处理 | MPL-2.0 不在白名单；Tailwind 自身不是禁用包 |
| caniuse-lite（连带 Babel/React Babel 插件链） | 浏览器支持数据库，为兼容转换提供依据 | CC-BY-4.0 不在白名单；现已选 SWC 替代 |
| spdx-exceptions（连带 spdx-expression-parse） | 标准许可证例外数据，让成熟解析器识别 SPDX 表达式 | CC-BY-3.0 不在白名单 |
| @univerjs-pro/* | 商业 xlsx 导入导出、图表、协同等 | AGENTS.md 与 03 §10 硬性禁用，不能仅凭包元数据允许 |
| HyperFormula | 公式计算、依赖图及重算 | GPL-3.0-only/商业路线，AGENTS.md 与 03 §10 硬性禁用 |

Kysely/Drizzle、better-sqlite3、ExcelJS/SheetJS/xlsx-populate 是架构或保真选择中未采用的方案，不是许可证黑名单；如重新采用，按现有 ADR 与验收目标评估。
