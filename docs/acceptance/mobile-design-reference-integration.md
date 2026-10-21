# 手机设计参考文档补充记录

- 日期：2026-09-30
- 环境：本机 macOS；工作区 `/Users/jiangwenxuan/Desktop/excelmanus-next`
- 范围：整理后补 `stitch_/` 手机表格与对话草稿；延续 [首次接入记录](design-reference-integration.md) 和 [ADR 0007](../decisions/0007-design-reference-integration.md)。仅记录文档检查，不是手机功能或 P2 验收。

## 整理结果

新增 [16 §7 手机页面参考](../16-design-reference.md#7-手机页面参考p2)，补齐来源、截图存档、组件映射、触摸/键盘/重连目标、差异处理与 P2 实机流程；README、02、13、15 和 ADR 0007 添加对应入口。

原草案的语音输入与逐项批次处理分别进入 [附录 C](../appendix-c-open-questions.md) P-12/P-13，保持未决定。置信度、自动预审、重复导航与示例数值未升级为产品承诺。手机仍为 P2，最终布局从实际功能出发，不要求一比一复刻。

## 已执行检查

| 检查 | 结果 | 证据位置 / 方法 |
| --- | --- | --- |
| 来源审阅 | 完成 | 阅读 `stitch_/studio_minimal_editorial/DESIGN.md`、两份 `code.html`，查看两张 `screen.png`；差异见 16 §7.4 |
| 视觉规范一致性 | 通过 | Node Buffer 逐字节比较 `stitch/` 与 `stitch_/` 的 DESIGN.md，两份相同；不新增手机视觉 token 体系 |
| 手机截图存档 | 通过 | Node Buffer 比较原稿与 `docs/design/reference/` 存档，两份相同；SHA-256 见下表 |
| 文档链接与标题锚点 | 通过 | Node 检查 16、ADR 0007、本记录的全部本地链接，以及 README/02/13/15/附录 C 指向设计参考的入口，共 37 个，缺失文件/锚点 0 个 |
| 变更空白 | 通过 | `git diff --check -- docs`；Node 检查上述八份 Markdown 的行末空白与末尾换行，均通过 |

| 存档文件 | SHA-256 |
| --- | --- |
| [手机表格草案](../design/reference/mobile-sheet-draft.png) | `0e44a14ce69916f4ed7fe4af6c7aac679bac19e931dc1a22f5d769c329eff867` |
| [手机对话草案](../design/reference/mobile-chat-draft.png) | `037ae2e21af2696a8d9c6708c0c4f0cc6717bf83744aaae55708e6fcd12e3fe3` |

## 验证边界

本次仅改文档与存档图片，原 `stitch_/` 文件、产品代码、依赖、安全及合规配置未改。未执行构建、产品测试、真实手机浏览器/PWA 或配对验收；软键盘、手势、后台续传与设备吊销均待 P2 留实机证据。参考截图不作为已实现页面、性能或里程碑通过证据。
