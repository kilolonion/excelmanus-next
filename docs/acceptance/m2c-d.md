# M2c/M2d 窄纵切验收记录

日期：2026-09-30（Asia/Shanghai）

## M2c 权限与审批

- `confirm` / `standard` / `auto` 权限矩阵已接入工具 effect 判定。
- `approval.requested` / `approval.decided` 写入会话日志；`pending_interactions` 和 `auto_approve_rules` 可由日志重建。
- 代理等待审批时状态进入 `blocked`；批准、拒绝和重复决定均可持久化处理。
- 真实 REST：`POST /api/v1/approvals/:id`，并提供会话审批查询。
- 重启后已批准的待执行工具从持久化 spec 恢复执行；副作用工具仍不自动重放，恢复前由审批决定继续。
- `packages/kernel/test/approval.test.ts`：真实 node:sqlite、日志投影、权限矩阵、幂等决定和自动批准规则通过。

## M2d 工作台编辑

- Univer 工作台切换为可编辑。
- 本端 mutation 捕获后经 `doc.submit` 发送，沿用服务端文档 actor、修订号和冲突检测。
- 自己的广播按连接 ID 去重；远端 mutation 按分片顺序串行回放。
- `doc.ack` 更新本地修订；`doc.reject` 重新读取权威快照撤销本地乐观修改；断线提交不自动重发。
- Web typecheck/build 和完整测试门禁通过。

## 已知窄实现

`ask_user` / `present` / `todo` 工具、问题回答 REST、真实等待/恢复、待办投影和前端交互卡片已接入。代理变更摘要已写入 `change.summary` 并在工作台显示最近变更；细粒度区域高亮仍是后续优化项。


## 追加收口（2026-09-30）

- `ask_user` 现由 `QuestionCoordinator` 持久化等待，回答后恢复 actor；重启后按 pending spec 恢复一次 tool result。
- 前端新增审批条、问题卡、区域确认/选取、待办清单和 `change.summary` 最近变更提示。
- 完整 `pnpm check:all`：14 个测试文件、72 个测试通过。

## M2 收口：摘要与定位（2026-09-30）

- `workbook_edit` 的 `change.summary` 现在包含受影响区域；工作台显示最近变更并可点击定位到区域高亮。
- 变更摘要经会话日志进入前端，可随会话恢复。
