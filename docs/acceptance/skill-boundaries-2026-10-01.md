# 2026-10-01 技能与指导内容边界调整验收

状态：内容归位、开发约束与机制验证完成；真实模型效果未验证；当前完整工作树门禁未全部通过。

依据：用户要求全面调整技能并建立后续开发约束；04 §7.1、12 §1.1/§1.6、14 §6、[ADR 0016](../decisions/0016-task-skills-and-guidance-boundaries.md)、[17 技能开发约束](../17-skill-authoring.md)。本轮在有并行未提交变更的工作树中实施，不 reset/stash/stage，不读取旧仓库代码。

## 1. 调整内容

- 退役内置 excelmanus-guide 与 script-patterns。产品帮助移入 docs/user-guide.md，在“外观与关于”使用同一 Markdown 源文件展示；脚本超时/访问/发布与代理角色/租约/队列契约随工具维护。
- 七个独立任务技能更新为 v2.0.0，补判断、可选路线、核验与交付边界；每个技能包含一个按情境读取的 references/examples.md，不机械注册细碎章节。
- 移除“相关任务先加载”要求；简单操作可直接使用工具。用户范围/模板/方法优先，批量不以文件数强制团队，对账不预设所有任务 0.01 容差。
- 必需依赖与可识别的未知工具引用按实时目录校验，覆盖正文和受资源读取限制的 Markdown 参考资料。预览标记不可用，斜杠与 skill 调用均不能绕过。optional-tools 标识有替代路线的可选工具，CI 检查内置可选名称合法。
- 保持权限、工具数量、来源覆盖和冻结历史；不删除用户/工作区技能或旧日志。桌面自检改为存在且依赖可用，不以“至少九个”作为完成条件。
- 17 与 AGENTS.md 写入职责、粒度、默认值依据、评审与证据约束；同步 04/06/12/14/15/README/附录 A。历史验收数量保留原环境，不改写为新数量。
- 七个合成场景与真实模型 CLI：fixtures/skill-evals/cases.ts、image-source.png、scripts/evaluate-skills.ts；说明见 docs/skill-evals.md。CLI 导出聚合指标和合成工作簿，删除临时凭据/日志，人工项始终单独标 pending。

## 2. 环境与命令

macOS arm64，本机 Node v24.1.0、pnpm 10.11.0。真实 127.0.0.1 HTTP/WebSocket，真实 SQLite 文件、工作簿服务、QuickJS 与模型网关；模型输出仅在机制测试中替代，评测 CLI 另用真实 HTTP 的假 OpenAI 兼容提供商验证链路。

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| 评测资源检查 | 通过：7 个场景；不证明真实模型效果 | node scripts/evaluate-skills.ts --validate |
| 聚焦技能验证 | 通过：5 files / 22 tests | .agents/tasks/skill-boundaries-2026-10-01/focused.log |
| 真实技能加载/资源/禁用/缺依赖/基础工具/投影重建 | 通过 | packages/server/test/e2e-skills.test.ts 第一场景 |
| 评测 CLI 真实适配与输出回读 | 通过：正确总额通过、错误总额失败；有 token/WS 指标，报告无测试凭据；人工项 pending | 同文件第二场景，假提供商只替代模型服务 |
| pnpm check:all 的 typecheck/lint/deps/licenses/build:web 阶段 | 通过；Biome 107 warnings、4 infos 未清零 | .agents/tasks/skill-boundaries-2026-10-01/check-all.log |
| pnpm check:all 的测试阶段 | 未通过：51 files 中 49 通过/2 失败，323 tests 中 321 通过/2 失败 | 同上 |
| 两项失败单独复核 | 仍失败：2 files、12 tests 通过/2 失败 | .agents/tasks/skill-boundaries-2026-10-01/workbook-recheck.log |
| 最终帮助源文件的 Web 构建 | 通过；保留现有大 chunk 警告 | .agents/tasks/skill-boundaries-2026-10-01/web-build.log |
| git diff --check | 通过 | 本轮执行，无输出 |

早一轮完整门禁曾以 50 files / 321 tests 通过，但随后加入评测 CLI 测试及并行工作树更新；不将较早结果当成当前工作树通过证据。

## 3. 浏览器复核

使用 packages/server/test/fixtures/ui-preview-server.ts 启动隔离真实后端与生产 Web 构建。设置页列出七个 v2.0.0 任务技能，无退役内置项；正文资源可经真实 API 返回。外观与关于的“阅读 ExcelManus 使用指南”展开后，辅助树包含帮助标题、任务/设置/审批/结果/安全边界章节，内容与源 Markdown 一致。

证据：[技能列表截图](skill-list-2026-10-01.png)、[帮助入口截图](skill-help-2026-10-01.png)。辅助树与页面文本已复核；未做窄屏、完整键盘或 Electron 实机复核。本轮未重打桌面安装包，因此不把源码自检修改视为安装包验收。

## 4. 未通过与未验证项

1. packages/modules/workbook/test/writeback.test.ts：已有值/公式格再次写公式，预期成功 rev 2，实际返回失败。
2. packages/server/test/e2e-doc.test.ts：区域冲突预期 VERSION_CONFLICT，实际返回 UNSUPPORTED_FEATURE。

本轮未编辑上述工作簿实现或测试文件；工作树有并行变更，两项失败的根因仍需对应工作簿路径调查。没有放宽断言、跳过测试或修改门禁来宣称通过。

真实模型的自主发现、任务质量改善、三类模型对照、视觉图像对照及人工复核均未执行，不能标 12 §1.6/14 §6 通过。场景与可执行评测器已经提供；本轮只证明机制与评测器能识别正确/错误输出。

工具引用检查是有限静态检查，不是内容质量分类器；大于 1 MiB 或未被资源清单包含的资料、自定义工具普通文字仍需人工审阅。冻结旧会话中的退役技能名称会在后续环境说明中更新；用户自装同名技能仍遵守来源优先级。

全量测试进程仍输出 QuickJS JS_FreeRuntime 断言；这是本轮完整工作树运行中观察到的清理告警，没有在技能调整中宣称修复。
