# 06 工具集

## 1. 设计原则

1. **少而完整**【硬性】：主代理的内置工具不超过 22 个。每个工具覆盖一个完整领域，靠参数中的 `mode`/`op` 区分动作，而不是每个动作一个工具。
2. **所见即所得**【硬性】：模型看到的工具列表就是它当前能用的全部。不做"按需发现/加载工具"，不存在"工具存在但被门控"的状态。因权限或角色不可用的工具直接不出现在列表里。
3. **工具说明只讲工具**【硬性】：工具说明回答"这个工具做什么、作用范围、参数含义、错误怎么处理"；"完成某类任务的步骤"属于技能（见 [12](12-skills-memory-mcp.md)）。
4. **结果诚实**【硬性】：统一的结果状态（§2.3），版本随结果返回，写入结果来自落盘后的回读。
5. **通用文件操作合并**：建目录、复制、移动、删除合为一个批量工具 `files`；列目录、按名查找、按内容查找合为 `find`。

### 选择工具的依据

工具说明提供用途与边界，字段细节由 schema 定义；不强制调用顺序。未知位置的文件用 `find`，完整路径已知时可直接读取；按名定位用精确文件名或 `**/文件名`，避免宽前缀混入无关文件。文本与图片内容用 `read`，工作簿内容/结构用 `workbook_read`，统计/对比/校验用 `workbook_analyze`，工作簿操作用 `workbook_edit`，自定义计算和批处理可用 `run_script`。版式需要时用 `workbook_render`，另存或拆分交付用 `workbook_export`；普通原地编辑不要求额外导出。

简单任务直接完成；独立子任务确有收益时才使用 `agent_spawn`，保留现有 main/lead/worker/reader 权限。可选 `handoff` 传递 goal、scope（path/sheet/range/rev）、constraints、deliverables、acceptance、evidence。这些字段随任务写入子代理的冻结提示词与初始消息，使用现有日志恢复，不创建第二份状态。scope 是相关区域，写入租约仍用 files；交接不会提升角色权限，也不能绕过写入时的版本检查。父代理根据实际交付核验结果。

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
| `read` | read | 读取文件。文本及 CSV/TSV 原文按物理行分页（默认 2000 行/16000 字符，保留前导零，返回 truncated 与续读游标）；图片作为视觉输入返回；工作簿返回简短概况并提示使用 `workbook_read`；技能资源用 `skill://<技能名>/<路径>` 读取 |
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
| `formula_graph` | 指定区域的公式、当前快照计算值、静态前驱与下游依赖；每项引用带逐格地址、实际值和公式。引用值合计最多2000格，`valueCoverage` 与引用的 `truncated` 明示截断；未计算的值标记 `valueAvailable=false`。深度可控；报告不能静态解析的引用（`INDIRECT`、`OFFSET`、外部工作簿等），不把外部/结构化/三维引用片段当成本地单元格值 |
| `table` | 把一块区域按表头抽取为结构化行（自动识别表头行，可指定），用于后续分析 |

**每个维度都如实报告覆盖情况**：`not_requested`（没查）、`empty`（查了，确实没有）、`unsupported`（引擎读不了）。三者不能混为空列表。

表名定位失败返回 NOT_FOUND，并列出当前工作簿实际表名；不要把未知表名当作内部故障重试。

`layout.rows/columns` 与 `layout.filter` 中的行列索引为0基。`rows.hd` 是独立行隐藏状态（也包含分组隐藏），筛选排除的行另记在 `filter.cachedFilteredOut`，不能仅看 `hd` 判断实际可见性。`layout.rowVisibility` 的 `rowNumberBase=1`，只覆盖 `readWindow.returnedRange` 实际返回的全部行，包含表头，不是仅明细：`rowStateHiddenRows` 来自行隐藏状态，`filteredOutRows` 来自筛选排除状态，`effectiveHiddenRows` 是两者并集，`visibleRows` 是其余行。可见编号按这些1基行号映射本次返回的 `values`；分页时不能当成全表可见行。筛选自身已隐藏不匹配行，不要再用 `axis.hide` 模拟，否则移除筛选后独立隐藏状态仍在。

### 4.2 `workbook_analyze`（read；带 `saveTo` 时 write）

分析与校验。`mode`：

| mode | 作用 |
| --- | --- |
| `sql` | 把指定工作表/区域（或其对应的 CSV 文档）注册为 `data` 表，执行只读 SQL（分组、窗口函数）。结果预览返回给模型；`saveTo` 可写入新工作表或新文件 |
| `profile` | 字段画像：类型推断、空值率、唯一值数、数值统计、高频值；`topCoverage` 明示高频值列表覆盖的非空记录数、总非空记录数和是否截断 |
| `diff` | 比较两个区域/工作表/文件：按位置或按业务键对齐，报告新增、删除、修改的行与单元格 |
| `check` | 规则校验：`required`、`unique`、`foreign_key`、`range`（数值/日期区间）、`pattern`、`row_expression`（行级表达式）、`cell`（某单元格等于期望值，带容差）、`total`（合计核对）、`formula_errors`（查 `#REF!` 等） |

`sql` 模式把当前 `sheet`/`range` 作为内存 SQLite 的 `data` 表；为兼容模型生成的查询，`{{sheet}}` 也会解析为 `data`。

`profile` 的 `top` 最多列出 5 种非空值，不是完整值清单。`topCoverage.coveredNonNull` 是列表中各值频次之和，`totalNonNull` 是整个输入区域的非空记录数（不含表头、空值和空字符串），`truncated` 标明二者是否不同。`frequencyTrackingTruncated=true` 表示频次跟踪超过 500 种值的上限，此时列表也不保证全局高频排名。不要据局部清单推断“全部”或“其余”值；最终数字应按最后一次修改后的证据逐项对应位置、单位和显示精度。

### 4.3 `workbook_edit`（write）

以一组类型化操作（ChangeSet）修改或新建工作簿，整批原子提交。

行高 `rows.height` 可附带一致的 `axis:"rows"`，列宽 `cols.width` 可附带 `axis:"cols"`；尺寸可使用 `pixels`，也可使用 `mode:"pixels", value`；两种写法同时出现时值必须一致。方向矛盾或无关字段仍拒绝，不静默改变操作。

参数：`path`、`baseRev`（可选，显式声明基于的修订；不传时用读集与当前修订判定）、`create`（新建）、`sheetNames`（可选的新建工作表名称列表）、`ops[]`、`dryRun`。

新建语义（[ADR 0014](decisions/0014-empty-workbook-tool-chain.md)）：`create=true` 必须提供尚不存在的 `.xlsx` 路径，不接受 `docId`。新工作簿默认已有一个空白 `Sheet1`；`ops=[]` 正式支持创建空工作簿，最小调用为 `{"create":true,"path":"空工作簿.xlsx","ops":[]}`。也可传 `sheetNames:["收款收据","核对"]` 直接按顺序建立目标表，不额外留下 Sheet1，`ops` 直接引用目标表名，不需再从 Sheet1 重命名；仅在新建时接受，名称校验、失败回滚与现有原子操作相同。脚本同一路径分多次暂存时只在首次提供。默认工作表改名仍可用 `sheet.rename`；`sheet.add` 只新增其他名称唯一的工作表。修改已有文件仍要求至少一个操作。预览与脚本 `wb.edit` 使用相同参数规则；失败的创建不留下占用该路径的文件。

Excel 表对象可用 `table.add`，传 `range`、工作簿内唯一 `name` 和按列顺序排列的 `columns:[{name,formula?}]`。范围包含表头与至少一行数据；列名会写入表头。计算列 `formula` 以首个数据行为基准，相对引用向下平移、绝对引用保留，同时写入 Excel 计算列元数据。已有表可用 `table.column_formula`，传 `sheet`、`table`、`column`、`formula` 更新整列，保留表头与合计行。两者均走现有原子提交、冲突检查与撤销链路；`workbook_read mode=overview` 的 `tables` 返回当前活文档表对象与计算列公式，不能用普通筛选代替 Excel 表对象。

公式批量写入可在同一 `ops` 先 `cells.set` 写首行公式，再 `cells.fill` 从首行区域向后续行填充；相对引用自动平移，`$` 绝对引用保留，无需逐行枚举公式。

操作类型【推荐】（每种一个判别字段 `op`，参数各自独立，禁止一个宽松对象复用字段）：

| 类别 | op |
| --- | --- |
| 工作表 | `sheet.add` `sheet.rename` `sheet.delete` `sheet.move` `sheet.copy` `sheet.hide` |
| 单元格 | `cells.set`（二维数组写值/公式）、`cells.fill`（向下/向右填充公式或序列）、`cells.clear`（内容/格式/全部） |
| 格式 | `style.set`（字体、填充、边框、数字格式、对齐、换行、缩进）、`merge` `unmerge` |
| 行列 | `rows.insert` `rows.delete` `cols.insert` `cols.delete` `axis.size`（列宽/行高/自动适配/按比例缩放） `axis.hide` `axis.group` |
| 数据 | `sort` `filter.set` `find_replace` `freeze` |
| 规则 | `cf.add` `cf.remove`（条件格式）、`dv.add` `dv.remove`（数据验证） |
| 命名区域 | `name.set`：name、带表名的 range，可选 scope 工作表；同名同作用域则更新，保存为绝对引用。overview 的 definedNames 读取当前名称，可用作下拉来源 |
| 对象 | `chart.add` `chart.update` `chart.delete`、`image.add`、`table.add` `table.column_formula`（Excel 表对象与计算列）、`name.set`（定义名） |
| 其他 | `hyperlink.set`、`note.set`（批注，P1）、`print.set`（打印设置，P1）、`recalculate` |

返回：
- `changes`：实际受影响的有限区域及其并集单元格数（重叠不重复计数），结构变化单独报告。冲突检测用的整行/整列/整表范围不作为实际修改格计数；删除空工作表不会报告 Excel 容量为修改格数。工具回执、脚本审批预览及轮次摘要共用此规则。
- 新建回执包含 `created=true` 与当前快照的 `sheets` 清单（名称、非空格数、公式数）；`dryRun=true` 中表示拟创建。即使 `ops=[]`，也提交可恢复的创建修订，记录默认工作表为新增结构。`workbook_read overview` 的计数来自当前修订快照，不使用导入时的缓存。
- 写入公式的**计算后的值**（引擎能算的），以及算不了的函数清单。
- 新修订号 `rev`（经 `docRevs` 返回）。
- `dryRun=true` 时不落盘，返回将产生的变更与预览引用（前端可渲染预览层，见 [02 §4.3](02-interaction.md#43-提问时让用户在表格上选择硬性确认结果必须绑定修订号)）。

不支持的操作或会丢失文件中已有对象的操作，整批拒绝并返回 `UNSUPPORTED_FEATURE`，说明是哪个部件。

条件格式工具 `cf.add` 支持 `kind=dataBar/colorScale`，沿用前端相同的原生规则。数据条使用 `fill` 和可选的两项 `values` 最小/最大数值；色阶使用低到高的 2 或 3 项 `colors` 与同数量递增 `values`。省略阈值按数据最小/最大取值，三色色阶中点使用 50% 分位。数据条当前为单色渐变、显示数值；此入口尚不提供图标集、公式阈值或 Excel 扩展数据条选项。普通高亮的 kind/样式字段仍保持原义。

`filter.set.clear=true` 只移除筛选，不能同时传非空 `columns`；设置条件用 false 或省略。服务端截图同时尊重手动隐藏与筛选隐藏的行，原始值读取仍包含全部行，并在 layout 返回筛选状态。

### 4.4 `workbook_render`（read）

把一个区域渲染成图片交给视觉模型。参数：`path`、`range`、`rev`（可选，默认当前修订）。返回图片（作为视觉输入）、渲染所用的修订号、行列与像素的对应关系、渲染限制说明（如"公式阈值条件格式未渲染"）。当前模型不支持视觉时，此工具不出现在工具列表中。

默认 `mode=browser-view` 截图实际 ExcelManus 工作簿视图（Univer 单元格和对象图层），并非 Excel 原生界面的像素等价承诺。服务端需配置 `EXCELMANUS_BROWSER_EXECUTABLE` 为支持默认 sandbox 的 Chromium 可执行文件，同时部署当前前端产物。未配置或截图失败会明确报错，绝不静默降级；可显式传 `mode=reconstructed` 使用旧数据重绘路径，其字体、复杂布局与对象效果可能近似。

若主服务以 root 运行，还必须显式配置 `EXCELMANUS_BROWSER_USER=devspace`，并已有非 root 的 devspace 账户和 `/usr/bin/setpriv`。仅截图浏览器子进程切换到该账户、清除附加组，主服务身份不变；不支持以 root 浏览器或 `--no-sandbox` 作为退路。浏览器使用本次新建的私有临时目录和最小环境变量，结束或超时后清理该目录。普通用户运行服务无需配置此身份变量；若配置，必须与当前身份一致。部署时须验证实际服务身份下截图成功，不能用另一账户的浏览器测试替代。

真实视图采用授权工作区中的冻结文档快照，只读独立页面，无登录凭据/数据 API/编辑同步。截图前后检查文档修订和源文件 SHA，不写源文件或备份；变化则拒绝图片。图片资源必须内嵌，网络仅允许必要同源静态资源。等待字体、图片、图表及稳定渲染帧，失败/超时不声称完整。

返回 `image.mode`、实际 PNG 字节 `sha256`、字节数、像素尺寸、docId/sheetId/rev、viewport/DPR/zoom/scroll、请求范围与可见范围。目前实际 viewport 为 1180×757、DPR=1、zoom=1；单图保留真实 UI 裁剪，滚动外区域不在图内。请求最多 80 行×30列；未完全可见返回 `partial`，应缩小范围分次截图。冻结窗格可能可见但主滚动范围不能完整描述，明确提示 partial。输入快照≤16MiB，PNG≤8MiB，provider 单次工具图片编码总量≤16MiB；超限明确拒绝，不以不可读缩放冒充保真。

仅已确认支持视觉的模型接收原生图片块；能力未知时保留文字结果并提示在模型设置中确认或切换视觉模型，不把 base64 当文本发送。被压缩的旧图片不在摘要内，需重新截图核对；尚未被后续模型输出消费的截图调用和结果一起保留，仍受预算限制。

重绘模式支持边框、数值条件高亮、色阶/数据条/图标集、已有八类图表及嵌入图片；按当前修订生成。公式条件支持当前表单元格与常量的比较，以及 AND/OR/NOT 组合，按规则起点平移相对引用并保留绝对引用。其他函数、跨表/名称/范围表达式、公式阈值仍在 limitations 中说明未渲染；不执行任意脚本，不改变工作簿计算或规则。未识别对象、特殊 Excel 图表样式、旋转裁剪仍有限制。

`cf.add` 新增或同 id 更新的规则置于最高优先级，多条提交时后加者优先；重叠区域需要强提示优先时，将该规则最后提交。验证规则的读回不等于已完成 Excel 或浏览器中的非法输入拦截实测。

重绘模式的数字显示复用已安装的 Excel 格式化引擎，支持货币、负数分段、百分比、自定义补零与常见日期时间格式；不改动原值。无法解析的格式降级为原值并在 limitations 中提示，仍不承诺 Excel 字体、格式色彩或复杂排版像素级一致。

图表交付核验可用 `workbook_read mode=objects` 的 `checkpointCharts`：它提供最近保存版本的系列引用和缓存采样，并返回保存修订 `rev`、当前读取修订 `currentRev` 与 `isCurrent`。仅 `isCurrent=true` 才能将该缓存视为当前版本证据；采样截断会明确标记，不代表全量验证。无需把 XLSX 压缩文件当作 UTF-8 文本读取。导入图表修改源数据时，当前表标准单行/列引用的已有缓存按实际引用刷新，保留原图引用、样式及扩展；外部、名称或非矩形引用不在此刷新范围内。

CSV 导入按前五条完整逻辑记录的列数一致性嗅探分隔符，字段中的带引号换行不会拆成采样记录。`workbook_export` 的 `exports` 回执提供输出路径、格式和 `sizeBytes`；CSV/TSV 另含 `encoding` 与由实际输出字节检查的 `bom`。文本解码可能剥离 BOM，不能用解码后的首字符否定回执，也无需另导临时副本比较大小。

截图成功后，实际渲染区域（按行列/尺寸上限截断后的 `range`）及所用修订记入代理读集，并可从持久上下文重建；渲染失败不记读集。它与区域读取采用同一冲突规则（[ADR 0018](decisions/0018-workbook-observations-and-derived-mutations.md)）。

### 4.5 `workbook_export`（write）

每次须显式提供源 `path` 或 `docId`；`to` 仅是输出路径，缺源参数时返回参数错误，不猜测当前文档。

`format` 省略时默认 `xlsx`，CSV/TSV 必须显式指定；文件扩展名仍须与格式一致。

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

memory 对模型提供扁平参数 schema：顶层必填 action，save 需要 content/category，search 需要 query，delete 需要 id。执行端仍按 action 的严格联合 schema 校验，拒绝缺失字段与其他分支的多余字段。这样分页 cursor 不会成为兼容模型通道唯一可见的顶层参数；不改变工具权限、记忆范围或副作用。

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
| `INVALID_ARGUMENT` | 参数不合法（附 `field`）；运行时 schema 校验失败还会在 `hint` 一次列出本次全部问题，数组下标从 0 开始，工具未执行 | 按提示修正参数 |
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
- `workbook_analyze`：sql/profile/diff/check。SQL 默认表 data，可附 `sources:[{name,path,docId,sheet,range}]` 联接其他文件或表；不指定 path/docId 时引用当前文档。结果列名须唯一，使用 AS 消除重复。diff 的 right 指定右侧数据，keys 可为组合业务键；输出 left/right 来源信息和每条差异的 beforeWorksheetRow/afterWorksheetRow（1 基实际工作表行，缺失侧为 null），beforeRow/afterRow 则是不含表头的1基明细行，报告定位使用实际工作表行；重复键诊断包含左右侧和冲突明细行；check 的 checks 判别字段为 kind，九类规则见 schema，行表达式使用只读 SQLite 表达式。
- `workbook_edit`：新增 chart.add/update/delete、image.add、cf.add/remove、dv.add/remove、rows.height/cols.width、axis.hide/group、sort、find_replace。尺寸单位像素；axis at/count 从1起；axis.size 的 mode=pixels 可用 value 或 pixels（同时提供必须一致），scale 仅用 value 倍率；group.level=0取消分组。sort.keys.column 为1基绝对列号，header 默认 true；引擎排序不移动隐藏行，需要时先取消隐藏。find_replace 默认 regex=false，find 和 replacement 都按字面量处理（不解释 `$&`）。regex=true 时 find 使用不带 `/` 分隔符的 JavaScript 正则，replacement 支持 `$1`、`$2`、`$&`、`$$`、`$<name>` 等标准替换语义。例如 find=`^ORD-([0-9]{3})$`、replacement=`INV-$1`；始终全局替换，caseSensitive 默认 false。仅处理指定 range 内的文本，不将文本数字转成数值，formulas 默认 false 跳过公式；无效正则在整个批次写入前报错。
- `workbook_edit` 的模型侧参数将操作投影为单层 `op` 枚举与合并字段，各操作的必填项和可选项均写入说明，明确每个操作只能使用自身列出的字段，避免跨操作混用（如把 `axis.size` 的 `axis` 传给 `cols.width`）。字段类型的差异保留为局部联合；这是用于生成参数的宽松投影，不是执行契约。服务端继续用原始 `ChangeOp` 严格校验必填项、类型和多余字段，未通过的调用不执行，不自动改写操作或强制代理改用其他工具。
- style.set 新增 fontFamily/fontSize/vAlign/indent/borders（top/bottom/left/right，每边 style/color，可传 null 清除）。原生导出保留没有修改的未知样式 XML。
- chart.range 含表头与分类列；常见八类型。导入复杂对象或不能保真的变换返回 UNSUPPORTED_FEATURE，不默默降级成图片或删除对象。
- 通用 `truncated.cursor` 是作用域隔离的结果游标。保留原入参并携带 cursor 后，运行时读取原日志结果，绝不重执行原写入；大字段按 JSON 文本分片。
- SQL 查询在独立子进程中硬超时/取消；每源20万格、合计40万格、序列化输入32MiB、结果20万格、默认10秒。查询失败不修改工作簿。

补齐推荐 op：sheet.copy（sheet/name/index）、sheet.move（sheet/index，从0起）、sheet.hide（sheet/hidden，至少保留一张可见表）、cells.fill（source/range/mode=copy|series）、axis.size（sheet/axis/at/count/mode=pixels|scale|auto/value）、filter.set（range、columns:[{column,values,blank}]，或 clear:true）、hyperlink.set（单格 range、url|null、label 可选）。auto 为无头尺寸估算；筛选限枚举/空值；复杂对象工作表复制安全拒绝。支持边界与开放产品问题见 ADR 0023。

### 区域读取的分页覆盖范围

workbook_read 的 range 模式保留请求的 range，另在值、公式和样式数组之前返回 truncated、nextOffset 和 readWindow。readWindow 包含 offset、returnedRows、totalRows、complete、returnedRange、remainingRange；实际未返回的行不能被当作已观察到的完整数据。需要更多内容时可按 nextOffset 续读，或自行选择其他范围及 facets；工具不强制 agent 的读取顺序。将分页信息放在大段数据之前，确保上下文预览裁剪后仍能发现剩余范围。

工具输入兼容：`find.pattern` 是 `glob` 的显式别名，冲突条件和未知字段拒绝，不静默变成无条件列目录。`present.payload` 通常为对象；模型返回 JSON 字符串时只解码一层，再按相同呈现协议严格校验。`workbook_analyze` 的 total 对指定范围所有数据行求和，不自动剔除合计行，失败中的 row=0 表示聚合结果。

参数示例：`present({payload:{kind:"file",path:"报告.xlsx"}})`，不能把 `kind/path` 放到根节点；`todo({op:"set",items:[{id:"1",title:"核验",status:"pending"}]})` 替换清单，`todo({op:"update",todoId:"1",status:"done"})` 更新单项，不重复传 `items`。`style.set` 用带表名的 `range`（如 `'汇总'!A1:D5`），不另传 `sheet`。这些误传仍严格拒绝，错误中提供对应修正示例。

数值证据终稿：本轮成功公式写入、SQL/profile 分析或有真实工作簿读取来源的脚本产生数值后，最终回复改用 `present({finalize:{status:"complete",sources:[{refId:"从工具正文复制的 refId"}]}})`。只能引用当前会话、当前代理可见且修订仍新鲜的读回/分析结果，不能填写自报值、自由标题或说明；额外合计、差值、位数、舍入解释须先由工具计算。服务端渲染真实结果及来源，此调用须单独执行，成功后结束本轮。无法完成时用 `present({finalize:{status:"incomplete",sources:[]}})`，固定说明数值交付未完成。普通 `payload` 分支不变。

complete、incomplete 以及执行步数限制产生的固定未完成终稿，都会附上服务端从本轮实际工具回执生成的执行事实，不由模型选择的数值 sources 决定。工作簿修改按调用逐条保留实际 path、docId、docRevs 与 backupPath（dryRun 不算写入，空变更只列为未提供写入证明的修改回执）；脚本严格区分已提交修订 committedRevs、published、rolledBack 与 unrecovered，不读取脚本 value 里的同名字段。字段缺失标明未提供，重复写入不证明恢复完成，提交不等同检查点或发布完成，回滚不等同从未发生发布。仅包括当前轮、显式数值恢复链及已校验关联的同会话子任务回执，不读取其他会话或普通新轮的历史。该附录不是全工具审计，也不证明授权、目标选择、任务完成或恢复正确；列表不静默截断，回执本身截断时明确执行事实未完整。

支持引用的成功结果在模型可读正文中附带宿主生成的 `numericEvidence`。默认 `sources:[{refId}]` 与可选 `candidates.items` 分开；仅报告部分指标时改选对应候选，不照抄 root 与全部子项。纯文字/布尔解释的默认 sources 为空，仍可从目录选入并与实际数值来源一起交付，整体必须至少包含一个真实数值。候选列出 valueType、字段/列名出处和单位状态，未有明确单位则为“未提供”，不从名称或数字猜测。目录至多160项、序列化列表至多12000字符，并列出 shown/total/truncated；未展示项不可猜引用，须缩小范围回读。截断/过大结果默认只选明确标记的可见数值子集，不能当作全量交付。超过上下文16000字符而只剩 preview 的结果不会从完整日志恢复候选。

refId 使用版本化的真实调用ID与规范 JSON Pointer 编码，不依赖候选序号、标签或值；它只是定位符，不是授权。新 provider schema 与实际 present.input 仅接受 refId，旧 pointer 只留内部历史选择器校验，不是新请求的兼容后门，也不修改历史日志。服务器须在同会话同代理仍可见的成功结果与真实记录中按同一契约重建候选，核验选择值一致、workspace/path/revision/SHA，最后同步复查修订。range 使用真实 readWindow.returnedRange；脚本读取 overview/objects 使用明确的 document metadata scope 并保留全部身份、版本与文件状态，不伪造全表区域，不声称缓存已刷新，不扩大可引用字段族。来源按身份、版本、hash和scope去重，不混合不同版本；同调用SQL/代码只输出一次，细选不扩大为root，root与子项重叠不重复计数或输出。仍保持32个提交引用、200个标量、24000字符与两次失败预算，未知或无效引用不能静默丢弃。`finalize` 与 `payload` 一样只兼容一层 JSON 字符串解码，随后严格校验；明确尝试 finalize 的参数错误也计入终稿两次失败上限，普通 present 参数错误不占该上限。

门启用后，模型自由文本只作为未展示草稿记录，工具卡和执行进度仍正常显示。显式停止后恢复继承未完成义务，所有新用户消息轮重新判定；只做 `workbook_read` 的任务不在首版硬门范围内。数值子任务的真实完成/失败/中断状态由运行时传给派生者，派生者须自己回读再交付，不能把子代理文字直接当证据。此机制保证值来自成功工具结果，不保证业务口径、公式选择或必报项语义完整性。

PDF 读取：`read` 支持内嵌文字和扫描页。`page` 从 1 起算，`pageCount` 默认 1、最多 3；文本按 16000 字符预算返回，续读使用 `nextPage` 和 `nextCharOffset`。扫描页自动提供 PNG 视觉输入，`render:true` 可同时查看文字页版式。输出明确总页数、已读页、页图像对应页号与续读位置；不把无可提取文字当作空文档。加密文件需解密副本，超过 50MB 需拆分。PDF.js（Apache-2.0）只解析和渲染本地字节，不执行 PDF 脚本或访问文档外链。

消息图片附件在模型上下文中标明附件名及来源：消息附件存储不是工作区路径，未指定关联文件。该元数据不改写用户正文，不为纯图片消息补造任务。

数据验证的 `dv.add` 列表选项可传原始逗号分隔文本或 Excel 引号字符串（如 `"待处理,完成"`、`="待处理,完成"`）；写入时统一解码一层引号，导出时只编码一次，避免下拉选项混入多余引号。以 `=` 开头的范围/名称表达式不作字符串解码。

`chart.update` 只修改显式提供的字段，省略的位置、尺寸、标题和数据范围保持现有值；`chart.add` 仍使用 E2 / 640×360 的创建默认值。

数值筛选示例：filter.set 的 columns 可用 {column:3, condition:{operator:"greaterThanOrEqual", value:300}}，与其他列枚举筛选按 AND 组合。values 只作精确匹配，不解析比较表达式；筛选自身隐藏行，不应再用 axis.hide 模拟，clear:true 移除筛选。

传统批注核验使用 workbook_read mode=objects 的 objects[].notes（当前修订的 ref/author/text）；preserved.comments 是最近落盘 OOXML 的目录信息，不替代当前值。读取失败或目录为空不应通过试写占位正文核验。批注读取保留换行、首尾空白及富文本各段文字。

sheet.rename 在应用工具路径中同时更新指向原工作表的单元格内部超链接（#表名!地址），保留显示文字、绝对地址和外部 URL；含空格或单引号的新表名使用 Excel 引号转义。隐藏工作表的链接目标保留，但不承诺 Excel 客户端可直接跳转到隐藏表。

拆分导出以末个有值或公式的行确定数据尾部，不把末尾仅有格式的行拆成空文件；保留内部空行和数值 0。区域 values 保持既有显示语义，新增 blankCells 地址列表帮助识别无值且无公式的单元格，保真复制时这些地址应写 null。按列分组可直接用 workbook_export mode=split，避免读取显示值后重建。

明确的两文件任务由宿主限制访问：可信用户原话中“把[当前] <源相对路径> 另存为/复制为 <输出相对路径>，只处理这两个文件，不访问或修改其他文件”建立精确集合，源文件只读、输出可读写。已有目录约束仍按原规则处理；文件限制不能扩大成公共父目录。未知、冲突或无法确定两个路径时停止文件操作，请用户另发明确任务，不从模型、附件或子代理文本扩权。有限文件任务拒绝父目录枚举、第三文件、符号链接与新建父目录；仅保留已授权目标必要祖先的元数据检查，输出父目录必须已存在。继续、恢复、子代理和脚本沿用同一宿主范围，写入在文档 actor 提交前检查，最终访问清单来自实际宿主记录。

成功的单文件复制仅在源/目标真实字节哈希一致、目标此前不存在且复制前后身份稳定时返回宿主 copyBaseline。它证明此次复制时的字节基线，不等于随后编辑仍保持原样；后者仍需当前保存件的结构、内容及修订证据。复制失败、部分完成、访问记录不确定或身份检查不足时不提供该成功证明。
