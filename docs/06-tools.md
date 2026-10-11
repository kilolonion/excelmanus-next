# 06 工具集

## 1. 设计原则

1. **少而完整**【硬性】：主代理的内置工具不超过 22 个。每个工具覆盖一个完整领域，靠参数中的 `mode`/`op` 区分动作，而不是每个动作一个工具。
2. **所见即所得**【硬性】：模型看到的工具列表就是它当前能用的全部。不做"按需发现/加载工具"，不存在"工具存在但被门控"的状态。因权限或角色不可用的工具直接不出现在列表里。
3. **工具说明只讲工具**【硬性】：工具说明回答"这个工具做什么、作用范围、参数含义、错误怎么处理"；"完成某类任务的步骤"属于技能（见 [12](12-skills-memory-mcp.md)）。
4. **结果诚实**【硬性】：统一的结果状态（§2.3），版本随结果返回，写入结果来自落盘后的回读。
5. **通用文件操作合并**：建目录、复制、移动、删除合为一个批量工具 `files`；列目录、按名查找、按内容查找合为 `find`。

## 2. 工具定义规范

### 2.1 每个工具必须声明【硬性】

| 字段 | 说明 |
| --- | --- |
| `name` | 小写蛇形，领域前缀（`workbook_*`、`agent_*`） |
| `title` | 中文显示名（工具卡片使用） |
| `description` | 发给模型的说明，按 §2.2 模板撰写 |
| `input` | 参数 schema（与契约包同一套 schema 系统），每个字段有说明 |
| `output` | 结果 schema |
| `effect` | `read` / `write` / `destructive` / `external` / `interactive` / `agent` / `state`；可以是参数的函数（如 `workbook_analyze` 仅在 `save_to` 存在时为 `write`） |
| `targets(args)` | 本次调用会读/写哪些路径，用于审批展示、租约检查、界面高亮 |
| `replay` | 中断后能否安全重放：`safe` / `unsafe` / `unknown` |
| `timeoutMs` | 默认超时 |
| `roles` | 哪些代理角色可用（见 [05 §5](05-multi-agent.md#5-角色与权限)） |

审批策略、审计记录、子代理工具裁剪、界面高亮、中断后的处理都从这些声明派生，不另写规则。

### 2.2 说明文字模板【推荐】

```text
<一句话：做什么>
何时使用：…
不要用于：…（改用 xxx）
参数要点：…（只写 schema 字段说明里放不下的跨字段规则）
常见错误：VERSION_CONFLICT → 重新读取后再写；…
示例：<一个最小调用>
```

- 单个工具说明（不含 schema）控制在约 1200 个汉字以内。
- 不写与其他工具重复的通用规则（如"所有写入都要声明基于的修订与读集"写在系统提示词的通用原则里一次）。
- 工具必须独立提供正确调用所需的契约；SDK、脚本发布、超时、角色和租约限制不能藏在需另行加载的技能中。任务路线与质量判断见 [17](17-skill-authoring.md)。
- 自动检查：说明中引用的其他工具名必须存在；示例必须通过 schema 校验。

### 2.3 统一结果结构【硬性】

```ts
type ToolResult = {
  status: "ok" | "error" | "partial";
  data?: unknown;                        // 工具特定内容
  error?: {
    code: string;                        // 见 §9 错误码
    message: string;                     // 给模型看的中文说明
    hint?: string;                       // 下一步建议
    field?: string;                      // 参数错误时的字段路径
    retryable: boolean;
  };
  versions?: Record<string, string>;     // 文本文件的内容哈希
  docRevs?: Record<string, number>;      // 相关活文档的当前修订号
  changes?: ChangeSummary;               // 写入类工具：实际落盘的变更摘要
  truncated?: { shown: number; total: number; cursor: string };
  images?: ImageRef[];                   // 需要进入模型视觉输入的图片
};
```

- "未执行"与"结果不确定"不是工具自己返回的，而是运行时在中断场景下标记的（见 [04 §8](04-agent-runtime.md#8-中断与恢复)）。
- 结果给模型的文本长度默认上限约 16,000 字符；超出时截断并给出 `cursor`，同一工具带 `cursor` 可继续取。
- 结果中的表格数据用紧凑格式（如 CSV 片段或行数组）给模型，不用冗长 JSON。

## 3. 文件工具（5 个）

路径一律相对工作区根；不能访问工作区外；不跟随指向工作区外的符号链接；`.excelmanus/` 内部目录对代理不可见（备份除外，见 `files` 的 `backup` 查询）。

| 工具 | effect | 作用 |
| --- | --- | --- |
| `read` | read | 读取文件。文本按行分页；图片作为视觉输入返回；工作簿与 CSV 返回简短概况并提示使用 `workbook_read`；技能资源用 `skill://<技能名>/<路径>` 读取 |
| `write` | write | 创建或整体覆盖**文本**文件（不能写工作簿）。覆盖已有文件必须带 `expectedVersion`；父目录自动创建 |
| `edit` | write | 对文本文件做精确字符串替换，可一次多处；必须带 `expectedVersion` |
| `find` | read | 列目录、按 glob 找文件、按内容搜索（文本文件与 CSV），参数：`path`、`glob`、`contains`、`depth`、`limit`；结果含类型、大小、修改时间、版本 |
| `files` | write / destructive | 批量文件管理：`ops: [{op:"mkdir"|"copy"|"move"|"delete"|"backup", ...}]`。整批预检，任一失败则整批不执行。`delete` 移入工作区回收站并需审批；`backup` 手动创建备份（修改前的自动备份不需要它） |

## 4. 表格工具（6 个）

所有表格工具：区域使用 A1 记法（`Sheet1!A1:D20`，工作表名含空格或特殊字符时加单引号）；行列 1 起算；返回 `docRevs`（相关文档的当前修订号）。

代理读取过的区域由运行时自动记入该代理的读集，写入提交时自动用于冲突检测（[03 §6.1](03-architecture.md#61-文档内)、[07 §10](07-workbook-engine.md#10-与代理的协作)），因此 `workbook_edit` **不要求**模型传 `expectedVersion`（可选参数 `baseRev` 用于显式声明基于的修订）。冲突时返回 `VERSION_CONFLICT`，附带被改单元格、修改者与修订号。

### 4.1 `workbook_read`（read）

读取工作簿事实。`mode`：

| mode | 返回 |
| --- | --- |
| `overview` | 工作表清单（名称、已用范围、行列数、隐藏状态、冻结窗格）、Excel 表对象、定义名、图表/图片/透视表数量、公式数量、是否含宏、不支持的特性清单 |
| `range` | 指定一个或多个区域的内容，`facets` 选择维度：`values`（值与显示文本）、`formulas`（公式与缓存值）、`styles`、`layout`（合并、行高列宽、隐藏）、`rules`（条件格式、数据验证）。默认 `values`。大区域分页 |
| `search` | 在值和/或公式中查找文本或正则，返回命中单元格 |
| `objects` | 图表（类型、数据范围、标题、锚点位置）、图片、透视表、表对象的详情 |
| `formula_graph` | 指定区域的前驱引用与下游依赖，深度可控；报告不能静态解析的引用（`INDIRECT`、`OFFSET`、外部工作簿等） |
| `table` | 把一块区域按表头抽取为结构化行（自动识别表头行，可指定），用于后续分析 |

**每个维度都如实报告覆盖情况**：`not_requested`（没查）、`empty`（查了，确实没有）、`unsupported`（引擎读不了）。三者不能混为空列表。

### 4.2 `workbook_analyze`（read；带 `saveTo` 时 write）

分析与校验。`mode`：

| mode | 作用 |
| --- | --- |
| `sql` | 把指定工作表/区域（或其对应的 CSV 文档）注册为 `data` 表，执行只读 SQL（分组、窗口函数）。结果预览返回给模型；`saveTo` 可写入新工作表或新文件 |
| `profile` | 字段画像：类型推断、空值率、唯一值数、数值统计、高频值 |
| `diff` | 比较两个区域/工作表/文件：按位置或按业务键对齐，报告新增、删除、修改的行与单元格 |
| `check` | 规则校验：`required`、`unique`、`foreign_key`、`range`（数值/日期区间）、`pattern`、`row_expression`（行级表达式）、`cell`（某单元格等于期望值，带容差）、`total`（合计核对）、`formula_errors`（查 `#REF!` 等） |

`sql` 模式把当前 `sheet`/`range` 作为内存 SQLite 的 `data` 表；为兼容模型生成的查询，`{{sheet}}` 也会解析为 `data`。

### 4.3 `workbook_edit`（write）

以一组类型化操作（ChangeSet）修改或新建工作簿，整批原子提交。

参数：`path`、`baseRev`（可选，显式声明基于的修订；不传时用读集与当前修订判定）、`create`（新建）、`ops[]`、`dryRun`。

新建语义（[ADR 0014](decisions/0014-empty-workbook-tool-chain.md)）：`create=true` 必须提供尚不存在的 `.xlsx` 路径，不接受 `docId`。新工作簿默认已有一个空白 `Sheet1`；`ops=[]` 正式支持创建空工作簿，最小调用为 `{"create":true,"path":"空工作簿.xlsx","ops":[]}`。默认工作表改名用 `sheet.rename`；`sheet.add` 只新增其他名称唯一的工作表。修改已有文件仍要求至少一个操作。预览与脚本 `wb.edit` 使用相同参数规则；失败的创建不留下占用该路径的文件。

操作类型【推荐】（每种一个判别字段 `op`，参数各自独立，禁止一个宽松对象复用字段）：

| 类别 | op |
| --- | --- |
| 工作表 | `sheet.add` `sheet.rename` `sheet.delete` `sheet.move` `sheet.copy` `sheet.hide` |
| 单元格 | `cells.set`（二维数组写值/公式）、`cells.fill`（向下/向右填充公式或序列）、`cells.clear`（内容/格式/全部） |
| 格式 | `style.set`（字体、填充、边框、数字格式、对齐、换行、缩进）、`merge` `unmerge` |
| 行列 | `rows.insert` `rows.delete` `cols.insert` `cols.delete` `axis.size`（列宽/行高/自动适配/按比例缩放） `axis.hide` `axis.group` |
| 数据 | `sort` `filter.set` `find_replace` `freeze` |
| 规则 | `cf.add` `cf.remove`（条件格式）、`dv.add` `dv.remove`（数据验证） |
| 对象 | `chart.add` `chart.update` `chart.delete`、`image.add`、`table.add`（Excel 表对象）、`name.set`（定义名） |
| 其他 | `hyperlink.set`、`note.set`（批注，P1）、`print.set`（打印设置，P1）、`recalculate` |

返回：
- `changes`：实际受影响的有限区域及其并集单元格数（重叠不重复计数），结构变化单独报告。冲突检测用的整行/整列/整表范围不作为实际修改格计数；删除空工作表不会报告 Excel 容量为修改格数。工具回执、脚本审批预览及轮次摘要共用此规则。
- 新建回执包含 `created=true` 与当前快照的 `sheets` 清单（名称、非空格数、公式数）；`dryRun=true` 中表示拟创建。即使 `ops=[]`，也提交可恢复的创建修订，记录默认工作表为新增结构。`workbook_read overview` 的计数来自当前修订快照，不使用导入时的缓存。
- 写入公式的**计算后的值**（引擎能算的），以及算不了的函数清单。
- 新修订号 `rev`（经 `docRevs` 返回）。
- `dryRun=true` 时不落盘，返回将产生的变更与预览引用（前端可渲染预览层，见 [02 §4.3](02-interaction.md#43-提问时让用户在表格上选择硬性确认结果必须绑定修订号)）。

不支持的操作或会丢失文件中已有对象的操作，整批拒绝并返回 `UNSUPPORTED_FEATURE`，说明是哪个部件。

### 4.4 `workbook_render`（read）

把一个区域渲染成图片交给视觉模型。参数：`path`、`range`、`rev`（可选，默认当前修订）。返回图片（作为视觉输入）、渲染所用的修订号、行列与像素的对应关系、渲染限制说明（如"条件格式未渲染"）。当前模型不支持视觉时，此工具不出现在工具列表中。

截图成功后，实际渲染区域（按行列/尺寸上限截断后的 `range`）及所用修订记入代理读集，并可从持久上下文重建；渲染失败不记读集。它与区域读取采用同一冲突规则（[ADR 0018](decisions/0018-workbook-observations-and-derived-mutations.md)）。

### 4.5 `workbook_export`（write）

`mode`：`convert`（xlsx/csv/tsv 互转，CSV 编码可选 UTF-8/UTF-8-BOM/GBK）、`split`（按列值或固定行数拆成多个文件）、`pdf`（P1）。只写新文件，不覆盖已有文件。

### 4.6 `run_script`（write，按实际发布内容判定）

在沙箱中运行 TypeScript/JavaScript，用于循环、复杂计算、批量处理。脚本通过 SDK 调用与上面工具同等的能力（`wb.read`、`wb.edit`、`wb.analyze`、`files.*`），所有写入先暂存，脚本成功结束才统一发布；失败、超时、取消则全部丢弃。详见 [08](08-sandbox.md)。

参数：`code`、`timeoutSeconds`（默认 30，上限 300）、`expectedVersions`（文本文件发布时按内容哈希校验；工作簿提交由文档 actor 按读集判定）。返回：标准输出尾部、返回值、发布的变更摘要。

## 5. 交互工具（3 个）

| 工具 | effect | 作用 |
| --- | --- | --- |
| `ask_user` | interactive | 向用户提问并等待回答。`type`：`choice`（`options`、`multiple`、`allowOther`）、`text`、`range_confirm`（`path`、`suggestedRange`、`note`）、`range_pick`（`path?`、`sheet?`、`count: "one"|"many"`）、`change_confirm`（`changesetRef`：来自 `workbook_edit` 的 `dryRun` 结果）。回答带版本（区域类题型）。可设 `timeoutSeconds`，超时返回"用户未回答" |
| `present` | read | 非阻塞地把内容呈现给用户：高亮区域（`focus`，附一句说明）、提供文件（下载/在工作台打开）。用于"请看这里"和交付文件 |
| `todo` | state | 维护本代理的待办清单：`set`（整体替换步骤列表）、`update`（改某项状态与结果）。界面实时显示 |

## 6. 代理协作工具（5 个）

语义见 [05](05-multi-agent.md)。

| 工具 | effect | 主要参数 |
| --- | --- | --- |
| `agent_spawn` | agent | `name`、`role`（reader/worker/lead）、`task`（任务说明）、`files`（写租约）、`model?`、`budget?` |
| `agent_send` | agent | `to`（ID/名称/`parent`/`children`，可多个）、`message`、`urgent?` |
| `agent_wait` | agent | `for`：`any_message` / `messages_from` / `all_idle`；`agents?`；`timeoutSeconds` |
| `agent_status` | read | `id?`（空则返回团队名册）、`include`：`summary` / `final_reply` / `transcript_tail` |
| `agent_control` | agent | `id`、`action`：`pause` / `resume` / `close` / `release_lease` |

`reader`/`worker` 角色只获得 `agent_send`、`agent_wait`、`agent_status`。

## 7. 扩展工具（2 个 + MCP）

| 工具 | effect | 作用 |
| --- | --- | --- |
| `skill` | read | 加载一个技能：返回技能正文与资源清单。可用技能列表在系统提示词里（只列名称与一句话描述） |
| `memory` | state | `save`（内容、类别）、`search`（关键词）、`delete`。记忆内容注入策略见 [12 §2](12-skills-memory-mcp.md#2-记忆) |

MCP 工具以 `mcp__<服务器>__<工具>` 命名加入列表，`effect` 由服务器声明的 `readOnlyHint` 决定：声明只读为 `read`，否则为 `external`（需审批，除非在自动批准名单中）。

## 8. 工具与角色矩阵

| 工具 | main | lead | worker | reader |
| --- | --- | --- | --- | --- |
| read / find | ✓ | ✓ | ✓ | ✓ |
| write / edit / files | ✓ | ✓ | ✓ | |
| workbook_read / analyze（无 saveTo） / render | ✓ | ✓ | ✓ | ✓ |
| workbook_edit / export / analyze（saveTo） | ✓ | ✓ | ✓ | |
| run_script | ✓ | ✓ | ✓ | 只读模式（不允许发布写入） |
| ask_user | ✓ | ✓ | ✓ | ✓ |
| present / todo | ✓ | ✓ | ✓ | ✓ |
| agent_spawn / agent_control | ✓ | ✓ | | |
| agent_send / wait / status | ✓ | ✓ | ✓ | ✓ |
| skill / memory | ✓ | ✓ | ✓ | ✓（memory 仅 search） |
| MCP | ✓ | 按派生参数 | 按派生参数 | 仅只读 MCP |

主代理共 21 个内置工具。

## 9. 错误码词表【硬性：统一词表，新增需登记】

| 码 | 含义 | 模型应该怎么做 |
| --- | --- | --- |
| `INVALID_ARGUMENT` | 参数不合法（附 `field`） | 按提示修正参数 |
| `NOT_FOUND` | 文件/工作表/区域不存在 | 用 `find` 或 `workbook_read overview` 确认 |
| `OUT_OF_WORKSPACE` | 路径越界 | 使用工作区内路径 |
| `VERSION_CONFLICT` | 读过或要写的区域在此后被修改（附单元格、修改者、修订号） | 只重读这些区域后再写 |
| `FILE_LEASED` | 文件由其他代理负责写入（附持有者） | 发消息给持有者或请父代理协调 |
| `APPROVAL_DENIED` | 用户拒绝（附理由） | 按用户理由调整，不要原样重试 |
| `UNSUPPORTED_FEATURE` | 引擎不支持该操作或会丢失已有对象（附部件） | 换方案或向用户说明 |
| `LIMIT_EXCEEDED` | 超出行数/结果大小/预算等上限 | 缩小范围或分批 |
| `TIMEOUT` | 超时 | 缩小范围；脚本类检查是否死循环 |
| `CANCELLED` | 被用户或系统取消 | 停止 |
| `SANDBOX_ERROR` | 脚本运行错误（附堆栈摘要） | 修正脚本 |
| `FORMULA_ERROR` | 写入的公式计算出错（附单元格与错误值） | 检查公式 |
| `EXTERNAL_ERROR` | MCP 等外部服务错误 | 视情况重试或说明 |
| `INTERNAL` | 系统内部错误（附诊断 ID） | 向用户报告 |

## 10. 与旧工具的对照

| 旧工具 | 新归属 |
| --- | --- |
| `observe_spreadsheet`、`trace_spreadsheet_formulas`、`extract_table` | `workbook_read`（mode） |
| `analyze_spreadsheet`、`query_spreadsheet`、`compare_spreadsheets`、`validate_spreadsheet` | `workbook_analyze`（mode） |
| `apply_spreadsheet_changes`、`calculate_spreadsheet` | `workbook_edit`（重算自动进行，也可用 `recalculate` op） |
| `preview_spreadsheet` | `workbook_render` |
| `convert_spreadsheet`、`split_spreadsheet` | `workbook_export` |
| `run_code` | `run_script` |
| `read` / `write` / `edit` | 保留 |
| `ls` | `find` |
| `copy_file`、`rename_file`、`delete_file`、建目录 | `files`（批量 op） |
| `ask_user` | 保留并扩展表格题型 |
| `offer_download` | `present` |
| `todolist` | `todo` |
| `spawn_subagent`、`list_subagents`、`read_subagent`、`control_subagent` | `agent_*` 五件套 |
| `introspect_capability`（知识门户） | 删除。工具用法随工具提供；产品说明放用户帮助和设置 UI，动态能力以实际工具目录与结果为准 |
| `delivery_status`、`verify_visual`（交付账本） | 删除。由运行时自动生成的变更摘要取代"模型自报交付证据" |
| Word 四件套 | 删除 |


## 2026-10-10 实现补充

不改变上方需求或推荐项，实际 API 以工具 Zod schema 为准：

- `workbook_read`：overview/range/search/objects/table/formula_graph。range facets 增加 styles、rules；layout 包含行列隐藏/分组、筛选与超链接。`objects` 可用 `imageId` 提取视觉图片，普通元数据不含 base64。`table` 首行作为表头，offset 按明细行分页；依赖图 depth 1–5、静态覆盖明确标注限制。
- `workbook_analyze`：sql/profile/diff/check。SQL 默认表 data，可附 `sources:[{name,path,docId,sheet,range}]` 联接其他文件或表；不指定 path/docId 时引用当前文档。结果列名须唯一，使用 AS 消除重复。diff 的 right 指定右侧数据，keys 可为组合业务键；check 的 checks 判别字段为 kind，九类规则见 schema，行表达式使用只读 SQLite 表达式。
- `workbook_edit`：新增 chart.add/update/delete、image.add、cf.add/remove、dv.add/remove、rows.height/cols.width、axis.hide/group、sort、find_replace。尺寸单位像素；axis at/count 从1起；group.level=0取消分组。sort.keys.column 为1基绝对列号，header 默认 true；引擎排序不移动隐藏行，需要时先取消隐藏。find_replace.find 是字面量，replacement 不解释 `$&`，默认不修改公式。
- style.set 新增 fontFamily/fontSize/vAlign/indent/borders（top/bottom/left/right，每边 style/color，可传 null 清除）。原生导出保留没有修改的未知样式 XML。
- chart.range 含表头与分类列；常见八类型。导入复杂对象或不能保真的变换返回 UNSUPPORTED_FEATURE，不默默降级成图片或删除对象。
- 通用 `truncated.cursor` 是作用域隔离的结果游标。保留原入参并携带 cursor 后，运行时读取原日志结果，绝不重执行原写入；大字段按 JSON 文本分片。
- SQL 查询在独立子进程中硬超时/取消；每源20万格、合计40万格、序列化输入32MiB、结果20万格、默认10秒。查询失败不修改工作簿。

补齐推荐 op：sheet.copy（sheet/name/index）、sheet.move（sheet/index，从0起）、sheet.hide（sheet/hidden，至少保留一张可见表）、cells.fill（source/range/mode=copy|series）、axis.size（sheet/axis/at/count/mode=pixels|scale|auto/value）、filter.set（range、columns:[{column,values,blank}]，或 clear:true）、hyperlink.set（单格 range、url|null、label 可选）。auto 为无头尺寸估算；筛选限枚举/空值；复杂对象工作表复制安全拒绝。支持边界与开放产品问题见 ADR 0023。
