import { FileOperationError } from "@excelmanus/kernel";
import { escapeXml } from "./xml.ts";

type Obj = Record<string, any>;
const list = (v: any): any[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
const valueTypes = new Set(["min", "max", "num", "percent", "percentile", "formula"]);
const iconTypes = new Set([
  "3Arrows",
  "3ArrowsGray",
  "4Arrows",
  "4ArrowsGray",
  "5Arrows",
  "5ArrowsGray",
  "3TrafficLights1",
  "3TrafficLights2",
  "3Signs",
  "3Symbols",
  "3Symbols2",
  "3Flags",
  "4RedToBlack",
  "4TrafficLights",
  "4Rating",
  "5Rating",
  "5Quarters",
]);
function fail(): never {
  throw new FileOperationError("UNSUPPORTED_FEATURE", "该条件格式含尚不能保真保存的选项");
}
function readValue(v: Obj) {
  const type = v?.["@_type"];
  if (!valueTypes.has(type)) return undefined;
  if (type === "min" || type === "max") return { type };
  const value =
    type === "formula" ? `=${String(v["@_val"] ?? "").replace(/^=/, "")}` : Number(v["@_val"]);
  if (type !== "formula" && !Number.isFinite(value)) return undefined;
  return { type, value };
}
function writeValue(v: Obj, extra = "") {
  if (!v || !valueTypes.has(v.type)) fail();
  const numeric = !["min", "max", "formula"].includes(v.type);
  if (numeric && !Number.isFinite(Number(v.value))) fail();
  if (["percent", "percentile"].includes(v.type) && (Number(v.value) < 0 || Number(v.value) > 100))
    fail();
  return `<cfvo type="${v.type}"${["min", "max"].includes(v.type) ? "" : ` val="${escapeXml(String(v.value ?? "").replace(/^=/, ""))}"`}${extra}/>`;
}
function color(v: unknown): string {
  if (typeof v !== "string" || !/^#[0-9a-f]{6}$/i.test(v)) fail();
  return v.toUpperCase();
}
function readColor(v: Obj) {
  const c = v?.["@_rgb"];
  return typeof c === "string" && /^(FF)?[0-9A-F]{6}$/i.test(c)
    ? `#${c.slice(-6).toUpperCase()}`
    : undefined;
}
function known(o: Obj, keys: string[]) {
  return o && Object.keys(o).every((k) => keys.includes(k));
}
export function importVisualRule(type: string, parsed: Obj): Obj | undefined {
  if (parsed.extLst) return undefined;
  if (type === "colorScale") {
    const c = parsed.colorScale;
    if (!known(c, ["cfvo", "color"])) return undefined;
    const values = list(c.cfvo).map(readValue),
      colors = list(c.color).map(readColor);
    if (
      ![2, 3].includes(values.length) ||
      colors.length !== values.length ||
      values.some((v) => !v) ||
      colors.some((v) => !v)
    )
      return undefined;
    return { type, config: values.map((value, index) => ({ index, color: colors[index], value })) };
  }
  if (type === "dataBar") {
    const c = parsed.dataBar;
    if (
      !known(c, ["cfvo", "color", "@_showValue", "@_minLength", "@_maxLength"]) ||
      (c["@_minLength"] !== undefined && Number(c["@_minLength"]) !== 10) ||
      (c["@_maxLength"] !== undefined && Number(c["@_maxLength"]) !== 90)
    )
      return undefined;
    const values = list(c.cfvo).map(readValue),
      rgb = readColor(c.color);
    if (values.length !== 2 || values.some((v) => !v) || !rgb) return undefined;
    return {
      type,
      isShowValue: c["@_showValue"] !== "0",
      config: {
        min: values[0],
        max: values[1],
        isGradient: true,
        positiveColor: rgb,
        nativeColor: rgb,
      },
    };
  }
  if (type === "iconSet") {
    const c = parsed.iconSet;
    if (!known(c, ["cfvo", "@_iconSet", "@_showValue", "@_reverse", "@_percent"])) return undefined;
    const iconType = c["@_iconSet"] ?? "3TrafficLights1",
      raw = list(c.cfvo),
      values = raw.map(readValue),
      n = Number(iconType[0]);
    if (!iconTypes.has(iconType) || values.length !== n || values.some((v) => !v)) return undefined;
    const reverse = c["@_reverse"] === "1";
    return {
      type,
      isShowValue: c["@_showValue"] !== "0",
      config: values
        .map((value, i) => ({
          operator: raw[i]["@_gte"] === "0" ? "greaterThan" : "greaterThanOrEqual",
          value,
          iconType,
          iconId: String(reverse ? i : n - 1 - i),
        }))
        .reverse(),
    };
  }
  return undefined;
}
export function exportVisualRule(rule: Obj): string {
  if (rule.type === "colorScale") {
    const config = rule.config;
    if (!Array.isArray(config) || ![2, 3].includes(config.length)) fail();
    return `<colorScale>${config.map((c) => writeValue(c.value)).join("")}${config.map((c) => `<color rgb="FF${color(c.color).slice(1)}"/>`).join("")}</colorScale>`;
  }
  if (rule.type === "dataBar") {
    const c = rule.config;
    if (!c || c.isGradient !== true || color(c.nativeColor) !== color(c.positiveColor)) fail();
    return `<dataBar showValue="${rule.isShowValue === false ? 0 : 1}">${writeValue(c.min)}${writeValue(c.max)}<color rgb="FF${color(c.positiveColor).slice(1)}"/></dataBar>`;
  }
  if (rule.type === "iconSet") {
    const c = rule.config;
    if (!Array.isArray(c) || !c.length) fail();
    const iconType = c[0].iconType,
      n = Number(iconType[0]);
    if (!iconTypes.has(iconType) || c.length !== n || c.some((v) => v.iconType !== iconType))
      fail();
    const normal = c.every((v, i) => v.iconId === String(i)),
      reverse = c.every((v, i) => v.iconId === String(n - 1 - i));
    if (!normal && !reverse) fail();
    if (c.some((v) => !["greaterThan", "greaterThanOrEqual"].includes(v.operator))) fail();
    return `<iconSet iconSet="${iconType}" showValue="${rule.isShowValue === false ? 0 : 1}" reverse="${reverse ? 1 : 0}">${[
      ...c,
    ]
      .reverse()
      .map((v) => writeValue(v.value, v.operator === "greaterThan" ? ' gte="0"' : ""))
      .join("")}</iconSet>`;
  }
  return fail();
}
