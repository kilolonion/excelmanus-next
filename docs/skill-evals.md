# 内置任务技能评测

本评测集补齐每个任务技能的真实输入与可检查输出，不替代 14 §6 的初始 40 任务评测集。资源检查和假提供商测试只证明评测链能运行；真实效果必须另行记录。

## 场景

合成输入、用户指令和单元格检查由 `fixtures/skill-evals/cases.ts` 定义，视觉输入为同目录的 `image-source.png`，源版式保存在 `image-source.html`。没有用户文件或生产凭据。

| caseId | 技能 | 易错判断 | 自动检查 | 人工复核 |
| --- | --- | --- | --- | --- |
| report-subtotal | report-building | 明细混有小计 | 地区金额与总额；源文件哈希不变 | 口径、独立核验 |
| clean-identifiers | data-cleaning | 前导零、完全重复、无效日期 | 文本编码、数值金额、未决日期；源文件不变 | 行数、诊断与失败清单 |
| reconcile-one-to-many | reconciliation | 一票多付款、缺失键 | 汇总与差额解释；源文件不变 | 未连接膨胀、分类与来源 |
| formula-fill | formula-help | 相对/绝对引用、填充 | 首末行有公式且计算值正确 | 固定税率引用、缓存边界 |
| style-readability | sheet-styling | 编码/度量和阅读层级 | 值保留且存在样式；源文件不变 | 数字格式、换行、列宽与视觉 |
| batch-same-name | batch-files | 不同目录同名输入 | 两份独立输出、条数与合计；源文件不变 | 每个输入状态、失败处理 |
| image-table | image-to-sheet | 前导零、金额、合计行 | 原图对应单元格、合计 | 必须实际视觉对照与单位核验 |

自动断言是最低证据，不覆盖所有额外行、错误解释、样式和语义问题；不能单凭自动通过宣称技能有效。新增真实失败案例时扩展对应任务，不把一种陷阱机械拆成新技能。

## 执行

先执行不联网的资源检查：

```sh
node scripts/evaluate-skills.ts --validate
```

真实模型执行使用显式指定的独立 API 模型配置文件，字段与 `CreateModelProfileBody` 一致。凭据仅保存在仓库外的评测配置中，不放入结果或 Git；脚本不读取现有应用数据目录和生产账号。示意配置（替换为自己的独立配置）：

```json
{
  "name": "skill-evaluation",
  "provider": "custom-openai-compatible",
  "model": "模型名",
  "baseUrl": "https://模型服务/v1",
  "apiKey": "仅在本地独立配置中填写"
}
```

对同一场景和模型分别运行：

```sh
node scripts/evaluate-skills.ts /absolute/path/eval-profile.json report-subtotal enabled /absolute/path/eval-results
node scripts/evaluate-skills.ts /absolute/path/eval-profile.json report-subtotal disabled /absolute/path/eval-results
```

每次启动隔离的真实后端、HTTP、WebSocket、SQLite、工具和模型网关；enabled 仅启用目标技能，disabled 全部禁用，用相同自然语言指令，避免用斜杠强制激活来掩盖发现问题。全局用户规则与记忆为空。合成任务使用 auto 权限，脚本仍走真实发布路径；不涉及外部工具与生产文件。

image-table 必须使用支持视觉的真实模型并先 `pnpm build:web`。脚本提示隔离服务器 URL 后，60 秒内在浏览器打开，连接真实产品渲染端；没有渲染端则记 `notRun/RENDERER_REQUIRED`，不模拟渲染。

输出包含独立结果目录、生成的工作簿和 `result.json`：模型/技能/输入/指令哈希、自动检查、源文件保留、文件交付、工具次数、技能加载次数、token、耗时、WebSocket 记录数、失败类别和待完成的人工项。自动检查通过的状态为 `automaticChecksPassed`，人工复核仍为 pending。缺少公式缓存不会按 0 通过；工具完成不等于文件交付。

执行结束删除临时应用数据目录（含凭据、主密钥、日志与提示词），只留下合成输出和聚合证据。失败不输出供应商原始错误正文，避免泄露密钥；具体诊断在隔离运行时复核，不导出凭据与提示词。

## 对照与记录

至少选择一个国际旗舰、一个国产主流和一个较小模型，按 14 §6 同时跑修改前后的版本；启用/禁用成对比较。记录提供商配置差异、采样设置与重复次数，不能把一次随机成功解释为稳定提升。

在 `docs/acceptance/` 写每对结果位置、自动与人工结论、模型是否自主加载、成功率/调用/token/耗时差异及失败类别。没有提升或出现退化时重新判断该指导是否必要；不能为满足技能数量而保留。

当前本轮的真实模型效果状态以 [技能边界调整验收](acceptance/skill-boundaries-2026-10-01.md) 为准。没有执行的模型、场景或人工项保持未验证。
