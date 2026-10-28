import type { ToolSpec } from "@excelmanus/protocol";

type Schema = Record<string, unknown>;
const object = (value: unknown): Schema | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Schema : undefined;

/** Model-only exact deduplication. Never replace the authoritative tool input. */
export function compactWorkbookCheckSpec(tool: ToolSpec, exactKindsOnly = false, keepAllKinds = false): ToolSpec {
  if (tool.name !== "workbook_check") return tool;
  let schema = tool.inputSchema;
  const scoped = (value: unknown): boolean => {
    if (Array.isArray(value)) return value.some(scoped);
    const node = object(value);
    return !!node && (Object.keys(node).some(key =>
      ["$ref", "$defs", "definitions", "$id", "$anchor", "$dynamicRef", "$dynamicAnchor", "$recursiveRef", "$recursiveAnchor"].includes(key)) ||
      Object.values(node).some(scoped));
  };
  const description = "写后首次检查直接 action=execute 并填写下列完整 verification（sources、outputs、checks），一次调用完成预检、登记及真实校验；不要先 describe/register/prepare。已有计划可用 planId/version。只在写前确需计划引用时 register；prepare 只做预检。checks 的 obligationId 对应任务义务，required_output 检查输出；expected 必须来自用户要求或真实读取/计算，不凭空填值。仅登记不代表通过，检查失败/unsupported 不得称完成。普通只读回答无需写出计划。describe 仅查询格式，不传 verification；tool=workbook_edit 和 ops 查编辑操作，auxiliaryGroups 查辅助工具。$ref 引用本工具 schema.$defs 中完整格式，所有宿主参数/权限/身份/保存与检查门禁不变。";
  if (scoped(schema)) return { ...tool, description };
  const children = (node: Schema, visit: (node: Schema) => Schema): Schema => {
    const next = { ...node };
    for (const key of ["properties", "patternProperties", "dependentSchemas"]) {
      const map = object(node[key]);
      if (map) next[key] = Object.fromEntries(Object.entries(map).map(([name, child]) =>
        [name, object(child) ? visit(object(child)!) : child]));
    }
    for (const key of ["anyOf", "oneOf", "allOf", "prefixItems"]) {
      const array = node[key];
      if (Array.isArray(array)) next[key] = array.map(child => object(child) ? visit(object(child)!) : child);
    }
    for (const key of ["items", "additionalProperties", "unevaluatedProperties", "contains", "not", "if", "then", "else", "propertyNames"]) {
      const child = node[key];
      if (object(child)) next[key] = visit(object(child)!);
      else if (key === "items" && Array.isArray(child))
        next[key] = child.map(value => object(value) ? visit(object(value)!) : value);
    }
    return next;
  };
  // Keep common checks fully specified; uncommon kinds remain callable after describe.
  // This changes model visibility only, not the original runtime VerificationInput.
  const common = new Set(["legacy_rules", "typed_aggregate"]);
  const select = (node: Schema): Schema => {
    const next = children(node, select);
    const key = Array.isArray(next.oneOf) ? "oneOf" : Array.isArray(next.anyOf) ? "anyOf" : undefined;
    if (!key || keepAllKinds) return next;
    const branches = next[key] as unknown[];
    const kinds = branches.map(branch => object(object(object(branch)?.properties)?.kind)?.const);
    if (!kinds.includes("legacy_rules") || !kinds.includes("typed_aggregate") ||
        kinds.some(kind => typeof kind !== "string")) return next;
    const other = kinds.filter(kind => !common.has(kind as string));
    next[key] = [
      ...branches.filter((_, index) => common.has(kinds[index] as string)),
      ...(other.length && !exactKindsOnly ? [{
        type: "object", properties: { kind: { type: "string", enum: other } },
        required: ["kind"], additionalProperties: true,
        description: "其他检查kind先 action=describe 获取完整verification格式，再按原格式execute；不要猜字段。宿主仍执行完整原schema校验。"
      }] : []),
    ];
    return next;
  };
  schema = select(schema);
  const counts = new Map<string, number>();
  const count = (node: Schema): Schema => {
    const key = JSON.stringify(node);
    if (Buffer.byteLength(key, "utf8") >= 45) counts.set(key, (counts.get(key) ?? 0) + 1);
    children(node, count);
    return node;
  };
  children(schema, count);
  const names = new Map<string, string>();
  const definitions: Schema = {};
  const replace = (node: Schema): Schema => {
    const key = JSON.stringify(node);
    if ((counts.get(key) ?? 0) > 1) {
      let name = names.get(key);
      if (!name) {
        name = "check" + names.size;
        names.set(key, name);
        definitions[name] = children(node, replace);
      }
      return { $ref: "#/$defs/" + name };
    }
    return children(node, replace);
  };
  const compact = { ...children(schema, replace), ...(names.size ? { $defs: definitions } : {}) };
  return { ...tool, description, inputSchema:
    Buffer.byteLength(JSON.stringify(compact), "utf8") < Buffer.byteLength(JSON.stringify(schema), "utf8") ? compact : schema };
}
