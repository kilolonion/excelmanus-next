# 设计参考文档接入记录

- 日期：2026-09-30
- 环境：本机 macOS；工作区 `/Users/jiangwenxuan/Desktop/excelmanus-next`
- 范围：将后补 `stitch/` 视觉规范与两份页面草案整理进 `docs/`。本记录是文档检查，不是 M1/M2 或其他产品里程碑验收。

## 整理结果

- 新增 [16 页面设计参考](../16-design-reference.md)，明确参考草案身份、不要求一比一复刻、最终设计以实际功能和用户任务为准。
- 新增 [ADR 0007](../decisions/0007-design-reference-integration.md)，记录接入方式；没有变更既有产品范围与安全约束。
- 在 README、02、09、13、14、15 中链接对应设计环节；保留此前 M1 修复记录与阶段未验收状态。
- 差异处理见 16 §5；配置导出作为 [附录 C P-11](../appendix-c-open-questions.md) 保持未决定。
- 原始截图存档至 `docs/design/reference/`，原始 HTML 与 `stitch/` 文件未修改。

## 已执行检查

| 检查 | 结果 | 证据位置 / 方法 |
| --- | --- | --- |
| 来源审阅 | 完成 | 阅读原始 DESIGN.md、两份 HTML，并查看两张 screen.png；16 §1.1 登记来源 |
| 新文档与接入链接 | 通过 | Node 文件与标题锚点检查：16、ADR 0007 的全部本地链接，以及六个接入章节和附录 C 中指向新文档的链接，共 21 个，缺失目标/锚点 0 个（本记录创建前执行） |
| 截图完整性 | 通过 | Node Buffer 逐字节比较原文件与存档文件：两份均相同；SHA-256 见下表 |
| 约定一致性人工复核 | 完成 | 16 §3.3、§4、§5 对照 01/02/04/07/09/10/11/13；未采用终端、分享、成员管理、撤销栈与预报成功修订等草案描述 |
| 变更空白检查 | 通过 | `git diff --check -- docs/README.md docs/02-interaction.md docs/09-models.md docs/13-desktop-mobile.md docs/14-quality.md docs/15-milestones.md docs/appendix-c-open-questions.md` |

| 存档文件 | SHA-256 |
| --- | --- |
| [工作台草案](../design/reference/workbench-draft.png) | `b5d81ff1c7ace88b40594317b91c8b33ebf570bfedf14520d89d4a285384efa6` |
| [设置草案](../design/reference/settings-draft.png) | `df6b7bceed6f4551f2c06ea47871b04cc74d5378c8579c2ed5422c9f20b81f16` |

## 验证边界与已知事项

本次只改文档并存档参考图片，未修改产品代码、依赖或合规配置。未执行产品类型检查、构建、运行测试或浏览器场景验收；不由本记录推导产品可用性、性能或阶段通过。

原始截图仍含已排除/待决的入口和示例数据，必须结合 16 §5 阅读。最终页面需在对应阶段按实际功能与真实 HTTP/WebSocket/SQLite 边界留证据；视觉复核按 14 §8、16 §6，不做草案像素匹配。
