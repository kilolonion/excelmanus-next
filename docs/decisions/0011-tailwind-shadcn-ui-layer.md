# 0011 使用 Tailwind CSS 4 与 Radix 上的自写组件层统一前端视觉

- 状态：已接受
- 日期：2026-10-01

## 背景

03 §10 的 UI 选型为「Tailwind CSS 4 + shadcn/ui」（【开放】）。M1 因 Tailwind 4 构建链依赖的 lightningcss（MPL-2.0）不在许可白名单，改用普通 CSS（见 `acceptance/m1-backend-slice.md`、`acceptance/dependency-reuse.md`）。到 M6a 第三轮，`packages/web/src/styles.css` 已有 3080 行、约 400 个类名，控件大量直接用浏览器原生元素（12 处 `<select>`、8 处复选框、10 处 `<details>`、12 个 `window.confirm` 确认点、约 70 处 `title` 提示），外观不统一、深色主题不跟随、设置中心无焦点陷阱。负责人 2026-10-01 决定：「Tailwind 直接使用」「直接许可」（批准 lightningcss 作为构建期例外）。审计与设计稿见 `.agents/tasks/web-visual-overhaul-tailwind-2026-10-01/design.md`。

## 选项

### 选项 A：继续手写 CSS token 体系

- 优点：无新依赖。
- 缺点：已证明难以保持一致；原生控件问题仍需自写全部可访问性逻辑。

### 选项 B：Tailwind CSS 4 + 在 Radix 原语上手写 shadcn 风格组件 + 精确的构建期许可例外

- 优点：与 03 §10 一致；Radix（MIT）负责焦点、键盘与 ARIA，视觉完全由我们的 token 决定。
- 缺点：新增约 25 个依赖包；需要一份许可例外。
- 风险：Tailwind preflight 与 Univer 样式冲突。

### 选项 C：Tailwind CSS 3（PostCSS 链）

- 缺点：常见链路需要 autoprefixer → caniuse-lite（CC-BY-4.0），同样不在白名单；且偏离 03 §10。

## 决定

选 B。

- 依赖（全部精确版本、发布满 7 天）：`tailwindcss`、`@tailwindcss/vite` 4.3.3、`tw-animate-css` 1.4.0（开发依赖）；`@radix-ui/react-*` 18 个原语、`class-variance-authority` 0.7.1、`clsx` 2.1.1、`tailwind-merge` 3.7.0、`lucide-react` 1.47.0（生产依赖）。不引入 autoprefixer、cmdk、`@tailwindcss/typography`、字体文件；不运行 shadcn CLI。
- 许可例外：`scripts/check-licenses.ts` 新增独立的 `BUILD_TIME_LICENSE_EXCEPTIONS`，只收 `lightningcss@1.32.0` 及其 11 个平台包 `@1.32.0`，许可字符串必须为 `MPL-2.0`；门禁另跑 `pnpm licenses list --prod`，例外包出现在生产依赖即失败。`ALLOWED_LICENSES`、`FORBIDDEN_PACKAGES`、`ACCEPTED_EXCEPTIONS` 不变。MPL-2.0 为文件级弱 copyleft，我们不修改其源码、产物（`dist/`、桌面 `build/app`）不含它。升级 Tailwind 带来新版本 lightningcss 时门禁会失败，须重新经负责人审批。
- 组件层：`packages/web/src/components/ui/`（button、input、select、dropdown-menu、controls、dialog、confirm、overlay、display、command、field、kbd、spinner、tooltip、cn）；业务组件只组合这些控件。图标只经 `components/Icon.tsx`（lucide，5 档尺寸、统一描边）。
- 样式：`styles.css` 为 CSS-first 配置（349 行）：层顺序 `theme < base < univer < components < utilities`，浅/深 token 经 `@theme inline` 映射，清空 Tailwind 默认调色板与字号刻度，字号随用户偏好缩放而不改根字号（Univer 用 rem）。
- Univer 共存：Univer 样式导入 `univer` 层；`base` 层末尾的守卫在 Univer DOM 内 `all: revert-layer` 撤销 preflight，排除 `html/body`（Univer 深色模式会给 `html` 加 `univer-dark`）与我们挂进浮层的 `[data-em-overlay]` 组件；表格区 `isolate`。画布叠加层颜色改为绘制时读取 token，主题切换后重绘。
- 视觉取值（16 §1 开放范围，留档）：系统字体栈；圆角 4/6/8/12/16；批准按钮为深色主操作（写入前不用成功色）；用户选区保持 Univer 默认蓝；设置中心保持模态对话框；Toast 右下角；字号用滑块。

## 后果

- 正面：原生选择控件、`<details>`、`window.confirm`、原生 `title` 提示在 `components/ui/` 以外清零，并由静态测试防回退；两套主题一致；设置中心有焦点陷阱与焦点归还。
- 负面 / 代价：CSS 产物 168 KB（gzip 27 KB，含 Univer）；JS 增量来自 Radix 与 lucide；本机 Web 需要较新浏览器（附录 C P-20）。
- 需要跟进：附录 C P-18（成功提示改 Toast）、P-19（控件边框对比度）、P-20（最低浏览器版本）；未做的验证见 `acceptance/m6a-frontend.md` §8。

## 验收标准符合性

14 §8、16 §6 与 15 M6a 的退出条件不变。新增：`test/gates/license-check.test.ts` 构建期例外反例 6 条（版本不符、部分版本、许可不一致、未列入 MPL 包、黑名单优先、生产依赖命中）；`packages/web/test/ui-conventions.test.ts` 静态检查（原生控件、`title` 提示、lucide 只经 Icon、组件内无中文字面量）。页面复核证据见 `acceptance/m6a-frontend.md` §8。
