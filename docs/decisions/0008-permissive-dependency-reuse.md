# 0008 复用合规依赖：Markdown 消毒与 React 开发插件

- 状态：已接受（既有许可约束内的实现调整）
- 日期：2026-09-30

## 背景

负责人要求检查被许可证或依赖问题排除的库，直接使用符合现有约束的成熟实现。M1 因误认为 DOMPurify 双许可不可使用而维护自写 HTML 消毒器；因 Babel 链的 caniuse-lite 不符合白名单，未接入 React 开发插件。

## 选项

1. 保持自写消毒器与 esbuild JSX，继续承担消毒维护成本并缺少 Fast Refresh。
2. 选择 DOMPurify 的 Apache-2.0 分支，使用官方 React SWC 插件，保留 Vite 7。
3. 放宽许可证策略，接入 Vite 8/Babel 链。本任务没有授权改变硬性策略，相关依赖列给负责人单独审批。

## 决定

采用选项 2：

- Web 使用 `dompurify@3.4.15`（2026-09-06 发布），选择 `(MPL-2.0 OR Apache-2.0)` 中的 Apache-2.0 分支。依赖携带的许可证保留，不裁剪。
- 删除自写危险标签/属性递归消毒，交给 DOMPurify。保留产品的 Markdown 标签、链接与代码语言属性限制，以及区域引用逻辑；引用转换后再次消毒最终 HTML。
- 使用 `@vitejs/plugin-react-swc@4.3.3`（2026-07-30 发布，MIT），并精确声明 `@swc/core@1.16.2`（2026-09-04 发布，Apache-2.0），避免范围依赖解析到刚发布版本。SWC 是开发构建依赖，运行时仍为浏览器 JS 与 Node source-first。
- 保持 Vite 7.3.6、`autoInstallPeers: false`、原白名单、黑名单与版本例外。无需改变许可策略。
- 评估过 `spdx-expression-parse@5.0.0`（MIT），但其传递依赖 `spdx-exceptions@2.5.0` 为 CC-BY-3.0，实际门禁拒绝。撤回该依赖及解析器替换，保留原门禁实现，待负责人审批。

元数据来源：`npm view <包>@<版本> license dependencies --json`、`npm view <包> time --json`；DOMPurify [上游许可说明](https://github.com/cure53/DOMPurify)、SWC [许可证](https://github.com/swc-project/swc/blob/main/LICENSE)。

## 后果与验收标准

- HTML 安全维护交给成熟消毒库；表格引用与普通 Markdown 的产品语义保留。
- 官方插件提供自动 JSX runtime 和 Fast Refresh。仅配置接入不能证明实际刷新交互通过。
- 新依赖仍须通过完整传递依赖许可证检查、Web 类型检查、构建与依赖方向检查；双许可 OR 放行、MPL 单许可及 AND 拒绝由门禁反例覆盖。
- SWC 涉及构建机平台二进制；本次未验证其他平台安装或桌面打包，不将其标记为通过。
- 负责人随后要求“不用实机验证”，停止浏览器/实机验证；实际执行范围见 [本次记录](../acceptance/dependency-reuse.md)。
