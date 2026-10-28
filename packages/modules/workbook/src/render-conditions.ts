import type { RenderLayout } from "@excelmanus/protocol";
import type { IWorkbookData, IWorksheetData } from "@univerjs/core";
import { renderRuleFormula } from "./render-rule-formula.ts";
import { CF_RESOURCE, rulesResource } from "./rule-codec.ts";

type Obj = Record<string, any>;
type Paint = Pick<RenderLayout["cells"][number], "dataBar" | "icon"> & {
  style?: Obj;
  hideValue?: boolean;
};
const number = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const inside = (range: Obj, r: number, c: number) =>
  r >= range.startRow && r <= range.endRow && c >= range.startColumn && c <= range.endColumn;
const compare = (v: number, operator: string, target: any) => {
  switch (operator) {
    case "greaterThan":
      return v > target;
    case "greaterThanOrEqual":
      return v >= target;
    case "lessThan":
      return v < target;
    case "lessThanOrEqual":
      return v <= target;
    case "equal":
      return v === target;
    case "notEqual":
      return v !== target;
    case "between":
      return Array.isArray(target) && v >= target[0] && v <= target[1];
    case "notBetween":
      return Array.isArray(target) && (v < target[0] || v > target[1]);
    default:
      return false;
  }
};
const blend = (a: string, b: string, ratio: number) => {
  const rgb = (c: string) => [1, 3, 5].map((i) => Number.parseInt(c.slice(i, i + 2), 16));
  if (!/^#[0-9a-f]{6}$/i.test(a) || !/^#[0-9a-f]{6}$/i.test(b)) return a;
  const aa = rgb(a),
    bb = rgb(b),
    t = Math.max(0, Math.min(1, ratio));
  return `#${aa
    .map((v, i) =>
      Math.round(v + (bb[i]! - v) * t)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
};
/** Evaluate declarative rules and bounded read-only predicates; disclose unsupported formulas. */
export function conditionalPaint(
  snapshot: IWorkbookData,
  sheet: IWorksheetData,
  limitations: string[],
) {
  const warn = (text: string) => {
    if (!limitations.includes(text)) limitations.push(text);
  };
  const compiled = (rulesResource(snapshot, CF_RESOURCE)[sheet.id] ?? []).flatMap((entry) => {
    const rule = entry.rule as Obj,
      ranges = entry.ranges as Obj[];
    if (!rule || !Array.isArray(ranges)) return [];
    const predicate =
      rule.type === "highlightCell" && rule.subType === "formula" && ranges[0]
        ? renderRuleFormula(
            String(rule.value ?? ""),
            sheet,
            ranges[0] as { startRow: number; startColumn: number },
          )
        : undefined;
    const total = ranges.reduce(
      (sum, r) => sum + (r.endRow - r.startRow + 1) * (r.endColumn - r.startColumn + 1),
      0,
    );
    if (total > 100_000) {
      warn("超过 100000 个单元格的条件格式统计未渲染");
      return [];
    }
    const values: unknown[] = [];
    const visited = new Set<string>();
    for (const range of ranges)
      for (let r = range.startRow; r <= range.endRow; r++)
        for (let c = range.startColumn; c <= range.endColumn; c++) {
          const key = `${r},${c}`;
          if (visited.has(key)) continue;
          visited.add(key);
          values.push(sheet.cellData?.[r]?.[c]?.v);
        }
    const frequencies = new Map<unknown, number>();
    for (const v of values) frequencies.set(v, (frequencies.get(v) ?? 0) + 1);
    const nums = values.filter(number).sort((a, b) => a - b),
      min = nums[0] ?? 0,
      max = nums.at(-1) ?? 0;
    const threshold = (v: Obj): number | undefined => {
      if (!v) return undefined;
      switch (v.type) {
        case "min":
          return min;
        case "max":
          return max;
        case "num":
          return number(v.value) ? v.value : undefined;
        case "percent":
          return min + ((max - min) * Number(v.value)) / 100;
        case "percentile": {
          const pos = ((nums.length - 1) * Number(v.value)) / 100,
            lo = Math.floor(pos),
            hi = Math.ceil(pos);
          return (nums[lo] ?? 0) + ((nums[hi] ?? 0) - (nums[lo] ?? 0)) * (pos - lo);
        }
        default:
          return undefined;
      }
    };
    if (
      rule.type === "highlightCell" &&
      !["number", "duplicateValues", "uniqueValues"].includes(rule.subType) &&
      !predicate
    ) {
      warn(`条件格式 ${rule.subType ?? rule.type} 尚不支持截图求值`);
      return [];
    }
    if (!["highlightCell", "colorScale", "dataBar", "iconSet"].includes(rule.type)) {
      warn(`条件格式 ${rule.type} 尚不支持截图`);
      return [];
    }
    const configs =
      rule.type === "dataBar"
        ? [rule.config?.min, rule.config?.max]
        : ["colorScale", "iconSet"].includes(rule.type)
          ? rule.config?.map((x: Obj) => x.value)
          : [];
    if (!Array.isArray(configs) || configs.some((v: Obj) => !Number.isFinite(threshold(v)))) {
      warn("公式或无效阈值条件格式未渲染");
      return [];
    }
    return [{ entry, rule, ranges, frequencies, threshold, predicate }];
  });
  return (r: number, c: number, value: unknown): Paint => {
    const out: Paint = {};
    for (const { entry, rule, ranges, frequencies, threshold, predicate } of compiled) {
      if (!ranges.some((range) => inside(range, r, c))) continue;
      let matched = false;
      if (rule.type === "highlightCell") {
        const evaluated = predicate?.(r, c);
        if (predicate && evaluated === undefined)
          warn("条件格式 formula 引用错误或未计算值，未渲染该单元格");
        matched = predicate
          ? evaluated === true
          : rule.subType === "number"
            ? number(value) && compare(value, rule.operator, rule.value)
            : value !== undefined &&
              value !== null &&
              value !== "" &&
              (rule.subType === "duplicateValues"
                ? (frequencies.get(value) ?? 0) > 1
                : frequencies.get(value) === 1);
        if (matched) out.style = { ...rule.style, ...out.style };
      } else if (number(value)) {
        matched = true;
        if (rule.type === "colorScale" && !out.style?.bg) {
          const stops = [...rule.config].sort((a: Obj, b: Obj) => (a.index ?? 0) - (b.index ?? 0));
          let color = stops[0]?.color;
          for (let i = 1; i < stops.length; i++) {
            const a = stops[i - 1],
              b = stops[i],
              lo = threshold(a.value)!,
              hi = threshold(b.value)!;
            color = blend(a.color, b.color, hi === lo ? 0 : (value - lo) / (hi - lo));
            if (value <= hi) break;
          }
          out.style = { ...out.style, bg: { rgb: color } };
        } else if (rule.type === "dataBar" && !out.dataBar) {
          const lo = Math.min(0, threshold(rule.config.min)!),
            hi = Math.max(0, threshold(rule.config.max)!),
            span = hi - lo || 1;
          const zero = Math.max(0, Math.min(1, -lo / span)),
            end = Math.max(0, Math.min(1, (value - lo) / span));
          out.dataBar = {
            start: Math.min(zero, end),
            end: Math.max(zero, end),
            color: value < 0 ? rule.config.nativeColor : rule.config.positiveColor,
            gradient: rule.config.isGradient === true,
          };
          out.hideValue = rule.isShowValue === false;
        } else if (rule.type === "iconSet" && !out.icon) {
          const config = rule.config as Obj[];
          const selected =
            config.find((x) => compare(value, x.operator, threshold(x.value))) ?? config.at(-1);
          if (selected)
            out.icon = {
              type: selected.iconType,
              index: Number(selected.iconId),
              count: config.length,
            };
          out.hideValue = rule.isShowValue === false;
        }
      }
      if (matched && entry.stopIfTrue) break;
    }
    return out;
  };
}
