import type { ToolSpec } from "@excelmanus/protocol";
import type { DatabaseSync } from "node:sqlite";
import { compactWorkbookCheckSpec } from "./compact-workbook-check.ts";

const auxiliaryToolGroups = {
  agents: ["agent_spawn", "agent_send", "agent_wait", "agent_status", "agent_control"],
  presentation: ["present"],
  skills: ["skill"],
  memory: ["memory"],
} as const;

export function isAuxiliaryTool(name: string): boolean {
  return Object.values(auxiliaryToolGroups).some(names => (names as readonly string[]).includes(name));
}

/** Visibility preferences, never authority. Durable receipts survive context compaction/resume. */
export function enabledAuxiliaryTools(db: DatabaseSync, sessionId: string, agentId: string): Set<string> {
  const enabled = new Set<string>();
  const rows = db.prepare(
    `SELECT DISTINCT json_extract(data, '$.toolName') AS tool_name, NULL AS groups
     FROM session_log WHERE session_id=? AND agent_id=? AND type='tool.intent'
       AND json_extract(data, '$.toolName') IN ('agent_spawn','agent_send','agent_wait','agent_status','agent_control','present','skill','memory')
     UNION ALL
     SELECT NULL AS tool_name, json_extract(data, '$.result.data.auxiliaryGroups') AS groups
     FROM session_log WHERE session_id=? AND agent_id=? AND type='tool.result'
       AND json_extract(data, '$.toolName')='workbook_check'
       AND json_extract(data, '$.status')='ok'
       AND json_extract(data, '$.result.status')='ok'
       AND json_extract(data, '$.result.data.action')='describe'
       AND json_type(data, '$.result.data.auxiliaryGroups')='array'`,
  ).all(sessionId, agentId, sessionId, agentId) as {tool_name: string | null; groups: string | null}[];
  for (const row of rows) {
    if (row.tool_name) {
      for (const names of Object.values(auxiliaryToolGroups))
        if ((names as readonly string[]).includes(row.tool_name)) for (const name of names) enabled.add(name);
    }
    if (!row.groups) continue;
    const groups: unknown = JSON.parse(row.groups);
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      if (typeof group !== "string" || !Object.hasOwn(auxiliaryToolGroups, group)) continue;
      for (const name of auxiliaryToolGroups[group as keyof typeof auxiliaryToolGroups]) enabled.add(name);
    }
  }
  return enabled;
}


function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

/** Model presentation only. The tool's original Zod input and effect checks remain authoritative. */
export function compactWorkbookEditSpec(tool: ToolSpec): ToolSpec {
  const schema = structuredClone(tool.inputSchema);
  const properties = object(schema.properties);
  const ops = object(properties?.ops);
  const items = object(ops?.items);
  const key = Array.isArray(items?.oneOf) ? "oneOf" : Array.isArray(items?.anyOf) ? "anyOf" : undefined;
  if (!ops || !items || !key) return tool;
  const branches = items[key] as unknown[];
  const common = new Set(["cells.set", "cells.clear", "sheet.add", "sheet.rename", "recalculate"]);
  const names = branches.map(branch => object(object(object(branch)?.properties)?.op)?.const);
  if (names.some(name => typeof name !== "string")) return tool;
  const kept = branches.filter((_, index) => common.has(names[index] as string));
  const other = names.filter(name => !common.has(name as string));
  if (!kept.length || !other.length) return tool;
  ops.items = {
    anyOf: [
      ...kept,
      {
        type: "object",
        properties: { op: { type: "string", enum: other } },
        required: ["op"],
        additionalProperties: true,
        description: "其他操作先用 workbook_check action=describe, tool=workbook_edit, ops=[操作名] 获取该操作的准确参数；服务端仍按完整原 schema 校验。",
      },
    ],
  };
  return {
    ...tool,
    description: "原子创建或修改一个工作簿。必传相对 path 或已读 docId；create=true 仅新 .xlsx、不覆盖，sheetNames 指定初始表，ops=[] 仅用于新建空表。常用 cells.set 支持值或公式（以=开头）；多表 range 必须含表名。其他 op 先 workbook_check action=describe, tool=workbook_edit, ops=[名称] 查准确字段与限制，不猜参数。baseRev 省略按真实读集判冲突；VERSION_CONFLICT 重读受影响范围。dryRun 只预览，成功后仍须读回/验证，calc=pending 不冒称公式已计算。宏/外链受原保留边界限制：先读 objects/overview，不能执行宏、新增改写外链或绕过未知签名限制；复杂对象按 describe 的原始说明处理。verification 仅引用先登记的 planId/version；登记不等于验证通过。运行期完整参数、权限、身份和写入检查不变。",
    inputSchema: schema,
  };
}

/** Short guidance only: every workbook_read input field and constraint is unchanged. */
const workbookReadDescription = "只读xlsx/csv，输入docId或工作区相对path；只取所需范围/facets，聚合用workbook_query，版式用workbook_render。overview取真实表名/规模/tables，勿猜Sheet1，单表可省略sheet。range取values/formulas/styles/layout/rules；values自带displayValues/displayBasis，不必额外取全styles。search按子串；table以range首行作表头；formula_graph取静态依赖及引用值/公式（depth1–5，最多2000引用格）；print取打印设置，不是浏览器分页；objects取图表/图片/shapes/notes、透视/缓存/切片器关系，imageId提图，notes核验批注，复杂对象按editable/reason仅保留。\n超2000格/16000字符分页，用nextOffset；readWindow区分requestedRange/effectiveRange/returnedRange，clipped为裁剪，complete仅offset后无剩余，不等于原请求全读。worksheetRows为真实Excel1基行号（保留空/隐藏行），table表头另见headerWorksheetRow。layout行列/合并几何0基，rowVisibility为1基；visibleRows配values核验可见编号，rows.hd不含全部筛选隐藏，勿用axis.hide模拟筛选。合并anchor/相交标记不证明锚点值已读；hyperlinks核验实际目标。blankCells保真复制写null，不填充空白/合并格；displayValues的null表示格式不支持，不代表原生视觉或保存缓存。\n内存值≠保存缓存，rev/mtime≠字节核验。检查sourceFile打开/当前SHA、changedSinceOpen、calculation，computed-in-memory-not-persisted未保存；变化未必本次造成。objects/overview的externalLinkDetails/checkpointExternalLinks给目标及两层保存缓存/isCurrent/packageState，不访问目标、不据内存#REF!推断保存结果；updated=false未更新，truncated/valueCoverage/valueAvailable明确不完整。外链公式只保留、不新增/覆盖/移动/本地重算；间接外部定义名/外部数组公式暂只读。checkpointPivots/Charts与isCurrent决定保存修订，pendingPivotRefresh不证明刷新；reportFacts只用白名单事实，savedDisplayTotal未知布局unsupported，不聚合cacheRecords或刷新。\nmacroEvidence静态给当前磁盘VBA字节/SHA及关系；checkpoint.isCurrent=false非当前保存版。cellEditSupport=conditional仅可尝试保真检查下普通cells.set，当前hash不保证未来保存，编辑后重读比对保存包。签名/歧义/不支持类型停止；不执行宏、不称宏结果已验证。勿用files.readText读XLSX或额外probe猜宏/缓存。";

/** Deduplicate only identical source annotations, never schema validation keywords. */
export function compactModelToolSpec(tool: ToolSpec): ToolSpec {
  if (tool.name === "workbook_read") return { ...tool, description: workbookReadDescription };
  if (tool.name !== "contract") return tool;
  const schema = structuredClone(tool.inputSchema);
  const sources: Record<string, unknown>[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) { value.forEach(visit); return; }
    const node = object(value);
    if (!node) return;
    const source = object(object(node.properties)?.source);
    if (source && typeof source.description === "string") sources.push(source);
    Object.values(node).forEach(visit);
  };
  visit(schema);
  const description = sources[0]?.description;
  // Differing future annotations keep their original field-specific placement.
  if (sources.length < 2 || typeof description !== "string" ||
      sources.some(source => source.description !== description)) return tool;
  for (const source of sources) delete source.description;
  return { ...tool, description: (tool.description ?? "") + "\n各处 source 共用说明：" + description,
    inputSchema: schema };
}

/** Share identical schema subtrees without changing their validation or descriptions. */
export function deduplicateModelToolSchema(tool: ToolSpec): ToolSpec {
  // Existing references or scoped identifiers must keep their original resolution.
  if (/"(?:\$ref|\$defs|definitions|\$id|\$anchor|\$dynamicRef|\$dynamicAnchor|\$recursiveRef|\$recursiveAnchor)"\s*:/.test(JSON.stringify(tool.inputSchema))) return tool;
  const schema = structuredClone(tool.inputSchema);
  const counts = new Map<string, number>();
  const mapChildren = (node: Record<string, unknown>, visit: (value: unknown) => unknown): Record<string, unknown> => {
    const result = {...node};
    for (const key of ["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"]) {
      const entries = object(node[key]);
      if (entries) result[key] = Object.fromEntries(Object.entries(entries).map(([name, value]) => [name, visit(value)]));
    }
    for (const key of ["items", "additionalProperties", "unevaluatedProperties", "contains", "not", "if", "then", "else", "propertyNames"]) {
      if (object(node[key])) result[key] = visit(node[key]);
    }
    for (const key of ["anyOf", "oneOf", "allOf", "prefixItems"]) {
      if (Array.isArray(node[key])) result[key] = (node[key] as unknown[]).map(visit);
    }
    return result;
  };
  const eligible = (key: string) => key.length >= 240 && !key.includes('"$ref"') && !key.includes('"$id"') && !key.includes('"$anchor"');
  const count = (value: unknown): unknown => {
    const node = object(value); if (!node) return value;
    const key = JSON.stringify(node);
    if (eligible(key)) counts.set(key, (counts.get(key) ?? 0) + 1);
    mapChildren(node, count); return value;
  };
  mapChildren(schema, count);
  const defs: Record<string, unknown> = {...object(schema.$defs)};
  const names = new Map<string, string>();
  const share = (value: unknown): unknown => {
    const node = object(value); if (!node) return value;
    const key = JSON.stringify(node);
    if ((counts.get(key) ?? 0) > 1) {
      let name = names.get(key);
      if (!name) {
        let index = names.size;
        do { name = `modelShared${index++}`; } while (Object.hasOwn(defs, name));
        names.set(key, name); defs[name] = node;
      }
      return {$ref: `#/$defs/${name}`};
    }
    return mapChildren(node, share);
  };
  const compact = mapChildren(schema, share);
  if (!names.size) return tool;
  compact.$defs = defs;
  return JSON.stringify(compact).length < JSON.stringify(schema).length ? {...tool, inputSchema: compact} : tool;
}

const stagedFamilies: Record<string, readonly string[]> = {
  files: ["files", "workbook_export"], scripts: ["run_script"], render: ["workbook_render"],
  text: ["read", "write", "edit"], workbook: ["workbook_read", "workbook_query", "workbook_edit"],
};
export interface StagedCatalogState {
  families: Set<string>;
  operations?: ReadonlySet<string>;
  ops: Set<string>;
  verification: boolean;
  fullVerification?: boolean;
  auxiliary?: Set<string>;
  workbook?: boolean;
  text?: boolean;
}

/** Task-bounded presentation preferences only; continuations reuse discovery, new tasks do not. */
export function stagedCatalogState(db: DatabaseSync, sessionId: string, agentId: string, turnId: string, contractId?: string): StagedCatalogState {
  const state: StagedCatalogState = {families:new Set(), ops:new Set(), verification:false, auxiliary:new Set()};
  const starts = db.prepare("SELECT seq FROM session_log WHERE session_id=? AND agent_id=? AND type='turn.started' AND (json_extract(data,'$.turnId')=? OR (? IS NOT NULL AND json_extract(data,'$.accessBinding.contractRef.contractId')=?)) ORDER BY seq")
    .all(sessionId,agentId,turnId,contractId ?? null,contractId ?? null) as {seq:number}[];
  const select = db.prepare("SELECT json_object('toolName',json_extract(data,'$.toolName'),'status',json_extract(data,'$.status'),'result',json_object('status',json_extract(data,'$.result.status'),'data',CASE WHEN json_extract(data,'$.toolName')='workbook_check' THEN json_extract(data,'$.result.data') ELSE NULL END)) AS data FROM session_log WHERE session_id=? AND agent_id=? AND type='tool.result' AND json_extract(data,'$.toolName') IN ('workbook_check','workbook_edit','write','edit','run_script') AND seq>? AND seq<COALESCE((SELECT MIN(seq) FROM session_log WHERE session_id=? AND agent_id=? AND type='turn.started' AND seq>?),9223372036854775807) ORDER BY seq");
  const rows = starts.flatMap(start => select.all(sessionId,agentId,start.seq,sessionId,agentId,start.seq) as {data:string}[]);
  for (const row of rows) {
    const record = object(JSON.parse(row.data));
    const result = object(record?.result);
    if (record?.status !== "ok" || result?.status !== "ok") continue;
    // Once a write has succeeded, make exact verification schemas available for readback/delivery repair.
    if (["workbook_edit","write","edit","run_script"].includes(String(record.toolName))) state.verification=true;
    const data = object(result.data);
    if (record.toolName !== "workbook_check" || data?.action !== "describe") continue;
    if (Array.isArray(data.toolFamilies)) for (const family of data.toolFamilies)
      if (typeof family === "string" && Object.hasOwn(stagedFamilies,family)) state.families.add(family);
    if (data.tool === "workbook_edit" && Array.isArray(data.ops)) for (const op of data.ops)
      if (typeof op === "string") state.ops.add(op);
    if (data.verificationSchema || data.verificationAvailable === true) {state.verification=true;state.fullVerification=true;}
    if (Array.isArray(data.auxiliaryGroups)) for (const group of data.auxiliaryGroups) {
      if (typeof group !== "string" || !Object.hasOwn(auxiliaryToolGroups,group)) continue;
      for (const name of auxiliaryToolGroups[group as keyof typeof auxiliaryToolGroups]) state.auxiliary!.add(name);
    }
  }
  return state;
}

const stagedCapabilityDirectory = "能力目录（知道能力不等于已获授权）：find枚举；read/write/edit文本；workbook_read读取工作簿，workbook_query聚合/SQL/profile/diff/sort_preflight，workbook_edit编辑/新建；files文件管理、workbook_export导出；run_script脚本批处理；workbook_render渲染；workbook_check检查；agent_spawn/send/wait/status/control协作，present展示，skill技能，memory记忆；ask_user必要澄清，deliver完成或partial/blocked。先用已有能力，不自行重写已支持功能。接受契约后常用任务工具直接提供，未显示的参数格式通过workbook_check describe按族/操作批量加载；同任务已加载保持可见，不反复发现。";
const stagedCheckDescription = "按contract能力目录选择所需族，批量action=describe,toolFamilies=[files|scripts|render|text|workbook]或auxiliaryGroups=[agents|presentation|skills|memory]。tool=workbook_edit,ops=[名称]一次加载1至8个精确操作。describe不带其他参数加载全部检查格式；写后常用检查自动显示，execute执行验证，register仅写前确需计划时用。同任务已加载不必重复发现。发现只返回短回执，准确schema在下一轮API tools；不执行、不授予权限。未提供族先使用read/query等现有能力，不为只读计算申请写权限。失败可修复重验，不能完成用deliver partial/blocked。";


/** One stable directory on the always-visible contract tool, including before a proposal. */
export function withStagedCapabilityDirectory(tool: ToolSpec): ToolSpec {
  return tool.name === "contract" ? {...tool,description:(tool.description ?? "")+"\n"+stagedCapabilityDirectory} : tool;
}

/** Stable order and append-only visibility for an active task; execution-time authorization is independent. */
export function appendStagedCatalog(previous: ToolSpec[], next: ToolSpec[]): ToolSpec[] {
  const updates=new Map(next.map(tool=>[tool.name,tool]));
  const names=new Set(previous.map(tool=>tool.name));
  return [...previous.map(tool=>updates.get(tool.name) ?? tool),...next.filter(tool=>!names.has(tool.name))];
}

/** Omit undiscovered optional families; exact host schemas remain the source of every visible branch. */
export function stagedModelToolSpec(tool: ToolSpec, state: StagedCatalogState): ToolSpec | undefined {
  const families=Object.entries(stagedFamilies).filter(([,names])=>names.includes(tool.name)).map(([family])=>family);
  const optional=families.some(family=>!["text","workbook"].includes(family));
  const fileTask = ["create","remove","relocate"].some(operation=>state.operations?.has(operation));
  if (optional && !families.some(family=>state.families.has(family) || (family === "files" && fileTask))) return undefined;
  if (families.includes("text") && state.text === false && !state.families.has("text")) return undefined;
  if (families.includes("workbook") && state.workbook === false && !state.families.has("workbook")) return undefined;
  if (isAuxiliaryTool(tool.name) && state.auxiliary && !state.auxiliary.has(tool.name)) return undefined;
  if (tool.name === "workbook_check") {
    if (state.verification) return {...compactWorkbookCheckSpec(tool, true, state.fullVerification === true),description:stagedCheckDescription};
    const schema=structuredClone(tool.inputSchema);
    const key=Array.isArray(schema.anyOf)?"anyOf":Array.isArray(schema.oneOf)?"oneOf":undefined;
    if (!key) return tool;
    const describe=(schema[key] as unknown[]).filter(branch=>object(object(object(branch)?.properties)?.action)?.const==="describe");
    if (!describe.length) return tool;
    schema[key]=describe;
    return {...tool,inputSchema:schema,description:stagedCheckDescription};
  }
  if (tool.name !== "workbook_edit") return compactModelToolSpec(tool);
  const schema=structuredClone(tool.inputSchema);
  const ops=object(object(schema.properties)?.ops),items=object(ops?.items);
  const key=Array.isArray(items?.oneOf)?"oneOf":Array.isArray(items?.anyOf)?"anyOf":undefined;
  if (!ops || !items || !key) return tool;
  
  const branches=items[key] as unknown[];
  const names=branches.map(branch=>object(object(object(branch)?.properties)?.op)?.const);
  if (names.some(name=>typeof name!=="string")) return tool;
  const common = new Set(["cells.set","cells.clear","sheet.add","sheet.rename","recalculate"]);
  items[key]=[
    ...branches.filter((_,index)=>common.has(names[index] as string)),
    ...[...state.ops].filter(name=>!common.has(name)).flatMap(name=>branches.filter((_,index)=>names[index]===name)),
  ];
  const omitted=names.filter(name=>!common.has(name as string));
  return {...compactWorkbookEditSpec(tool),inputSchema:schema,description:compactWorkbookEditSpec(tool).description+
    (omitted.length?" 按需操作目录："+omitted.join(",")+"；当前schema已有该op则直接使用，不重复describe；尚未显示才describe查询准确字段。":"")};
}
