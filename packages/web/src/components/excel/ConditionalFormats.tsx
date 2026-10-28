import { indexToCol, parseRange } from "@excelmanus/core";
import type { IRange } from "@univerjs/core";
import {
  AddCfCommand,
  CFNumberOperator,
  CFRuleType,
  CFValueType,
  ConditionalFormattingRuleModel,
  DeleteCfCommand,
  type IConditionalFormattingRuleConfig,
  type IConditionFormattingRule,
  IIconSetType,
  type IValueConfig,
  iconMap,
  SetCfCommand,
} from "@univerjs/sheets-conditional-formatting";
import { ChevronDown, Palette, Pencil, Plus, Trash2 } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { confirmAction } from "@/components/ui/confirm-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { OverlayCard, OverlayCardBody, OverlayCardHeader } from "@/components/ui/overlay-card";
import { toast } from "@/components/ui/toaster";
import { createFrameRefresh } from "@/lib/workbook/frame-refresh";
import type { SheetApi } from "./FormatToolbar";

type Kind = "colorScale" | "dataBar" | "iconSet";
const kinds = [
  ["colorScale", "色阶"],
  ["dataBar", "数据条"],
  ["iconSet", "图标集"],
] as const;
const types = [
  ["min", "最小值"],
  ["max", "最大值"],
  ["num", "数值"],
  ["percent", "百分比"],
  ["percentile", "百分位"],
  ["formula", "公式"],
] as const;
const icons = [
  ["3Arrows", "三色箭头"],
  ["3TrafficLights1", "三色信号灯"],
  ["3Symbols", "三种符号"],
  ["3Flags", "三色旗帜"],
  ["4Arrows", "四级箭头"],
  ["4Rating", "四级评级"],
  ["5Arrows", "五级箭头"],
  ["5Rating", "五级评级"],
] as const;
const visual = (rule: IConditionalFormattingRuleConfig) => kinds.some(([k]) => k === rule.type);
const rangesText = (ranges: IRange[]) =>
  ranges
    .map(
      (r) =>
        `${indexToCol(r.startColumn + 1)}${r.startRow + 1}:${indexToCol(r.endColumn + 1)}${r.endRow + 1}`,
    )
    .join(" ");
const iconConfig = (iconType: IIconSetType) =>
  Array.from({ length: Number(iconType[0]) }, (_, i) => ({
    operator: CFNumberOperator.greaterThanOrEqual,
    value: {
      type: CFValueType.percent,
      value: Math.round((100 * (Number(iconType[0]) - 1 - i)) / Number(iconType[0])),
    },
    iconType,
    iconId: String(i),
  }));
function defaults(kind: Kind): IConditionalFormattingRuleConfig {
  if (kind === "dataBar")
    return {
      type: CFRuleType.dataBar,
      isShowValue: true,
      config: {
        min: { type: CFValueType.min },
        max: { type: CFValueType.max },
        isGradient: true,
        positiveColor: "#16A34A",
        nativeColor: "#16A34A",
      },
    };
  if (kind === "iconSet")
    return {
      type: CFRuleType.iconSet,
      isShowValue: true,
      config: iconConfig(IIconSetType.threeArrows),
    };
  return {
    type: CFRuleType.colorScale,
    config: [
      { index: 0, color: "#F8696B", value: { type: CFValueType.min } },
      { index: 1, color: "#FFEB84", value: { type: CFValueType.percentile, value: 50 } },
      { index: 2, color: "#63BE7B", value: { type: CFValueType.max } },
    ],
  };
}
function Choice({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: readonly (readonly [string, string])[];
  onChange: (value: string) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" aria-label={label} className="justify-between gap-2">
          {options.find(([v]) => v === value)?.[1] ?? value}
          <ChevronDown className="size-3" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="max-h-64">
        <DropdownMenuRadioGroup value={value} onValueChange={onChange}>
          {options.map(([v, label]) => (
            <DropdownMenuRadioItem key={v} value={v}>
              {label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
function Threshold({
  label,
  value,
  onChange,
}: {
  label: string;
  value: IValueConfig;
  onChange: (v: IValueConfig) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="w-16 text-xs text-muted-foreground">{label}</span>
      <Choice
        label={`${label}类型`}
        value={value.type}
        options={types}
        onChange={(t) =>
          onChange({
            type: t as CFValueType,
            ...(["min", "max"].includes(t) ? {} : { value: t === "formula" ? "=" : 0 }),
          })
        }
      />
      {!["min", "max"].includes(value.type) && (
        <Input
          className="h-8 min-w-0 flex-1"
          aria-label={`${label}值`}
          value={value.value ?? ""}
          onChange={(e) =>
            onChange({
              ...value,
              value:
                value.type === CFValueType.formula
                  ? e.target.value
                  : e.target.value === ""
                    ? ""
                    : Number(e.target.value),
            })
          }
        />
      )}
    </div>
  );
}
function Color({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <Input
        type="color"
        className="h-8 w-10 shrink-0 cursor-pointer p-1"
        aria-label={`${label}选择`}
        value={/^#[0-9a-f]{6}$/i.test(value) ? value : "#000000"}
        onChange={(e) => onChange(e.target.value.toUpperCase())}
      />
      <Input
        className="h-8 font-mono text-xs"
        aria-label={label}
        value={value}
        placeholder="#16A34A"
        onChange={(e) => onChange(e.target.value.toUpperCase())}
      />
    </div>
  );
}
export function ConditionalFormats({ api, disabled }: { api: SheetApi | null; disabled: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="条件格式"
        title="条件格式"
        disabled={disabled}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setOpen(true)}
      >
        <Palette className="size-4" />
      </Button>
      <OverlayCard open={open} onOpenChange={setOpen} size="lg">
        {open && api && <Editor api={api} onClose={() => setOpen(false)} />}
      </OverlayCard>
    </>
  );
}
function Editor({ api, onClose }: { api: SheetApi; onClose: () => void }) {
  const fieldId = useId();
  const sheet = api.wb.getActiveSheet(),
    sid = sheet.getSheetId(),
    unitId = api.wb.getId();
  const model = api.univer.__getInjector().get(ConditionalFormattingRuleModel);
  const [rules, setRules] = useState<IConditionFormattingRule[]>(() => [
    ...(model.getSubunitRules(unitId, sid) ?? []),
  ]);
  const [draft, setDraft] = useState<IConditionFormattingRule | null>(null);
  const [editing, setEditing] = useState(false),
    [range, setRange] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    const refresh = createFrameRefresh(() =>
      setRules([...(model.getSubunitRules(unitId, sid) ?? [])]),
    );
    const sub = model.$ruleChange.subscribe((e) => {
      if (e.unitId === unitId && e.subUnitId === sid) refresh.schedule();
    });
    return () => {
      refresh.dispose();
      sub.unsubscribe();
    };
  }, [model, unitId, sid]);
  const change = (fn: (r: IConditionalFormattingRuleConfig) => void) =>
    setDraft((d) => {
      if (!d) return d;
      const next = structuredClone(d);
      fn(next.rule);
      return next;
    });
  const begin = (item?: IConditionFormattingRule) => {
    const ranges =
      item?.ranges ??
      sheet
        .getSelection()
        ?.getActiveRangeList()
        .map((r) => r.getRange()) ??
      [];
    setDraft(
      item
        ? structuredClone(item)
        : { cfId: crypto.randomUUID(), ranges, stopIfTrue: false, rule: defaults("colorScale") },
    );
    setRange(rangesText(ranges));
    setEditing(Boolean(item));
    setError("");
  };
  const save = async () => {
    if (!draft) return;
    setError("");
    try {
      const ranges = range
        .trim()
        .split(/\s+/)
        .map((text) => {
          const r = parseRange(text.replaceAll("$", ""));
          if (r.sheet && r.sheet !== sheet.getSheetName())
            throw new Error("选区必须属于当前工作表");
          return {
            startRow: r.startRow - 1,
            endRow: r.endRow - 1,
            startColumn: r.startCol - 1,
            endColumn: r.endCol - 1,
          };
        });
      if (
        !ranges.length ||
        ranges.some(
          (r) =>
            r.startRow < 0 ||
            r.startColumn < 0 ||
            r.endRow >= sheet.getMaxRows() ||
            r.endColumn >= sheet.getMaxColumns(),
        )
      )
        throw new Error("选区超出当前工作表");
      const rule = draft.rule;
      const points =
        rule.type === CFRuleType.colorScale
          ? rule.config.map((c) => c.value)
          : rule.type === CFRuleType.dataBar
            ? [rule.config.min, rule.config.max]
            : rule.type === CFRuleType.iconSet
              ? rule.config.map((c) => c.value)
              : [];
      for (const p of points) {
        if (["min", "max"].includes(p.type)) continue;
        if (p.type === CFValueType.formula) {
          if (typeof p.value !== "string" || !p.value.startsWith("=") || p.value.length < 2)
            throw new Error("请输入以 = 开头的有效阈值公式");
        } else {
          if (p.value === "" || p.value === undefined || !Number.isFinite(Number(p.value)))
            throw new Error("阈值必须是有效数字");
          if (
            ["percent", "percentile"].includes(p.type) &&
            (Number(p.value) < 0 || Number(p.value) > 100)
          )
            throw new Error("百分比和百分位应在 0–100 之间");
        }
      }
      const colors =
        rule.type === CFRuleType.colorScale
          ? rule.config.map((c) => c.color)
          : rule.type === CFRuleType.dataBar
            ? [rule.config.positiveColor]
            : [];
      if (colors.some((c) => !/^#[0-9a-f]{6}$/i.test(c)))
        throw new Error("颜色请填写 # 加 6 位十六进制值");
      setBusy(true);
      await api.wb.endEditingAsync(true);
      const ok = await api.univerAPI.executeCommand(editing ? SetCfCommand.id : AddCfCommand.id, {
        unitId,
        subUnitId: sid,
        cfId: draft.cfId,
        rule: { ...draft, ranges },
      });
      if (!ok) throw new Error("条件格式未应用，请重试");
      setDraft(null);
      toast({ title: editing ? "条件格式已更新" : "条件格式已添加" });
    } catch (e) {
      setError(e instanceof Error ? e.message : "保存失败");
    } finally {
      setBusy(false);
    }
  };
  const remove = async (item: IConditionFormattingRule) => {
    if (
      !(await confirmAction({
        title: "删除这条条件格式？",
        description: `${sheet.getSheetName()} · ${rangesText(item.ranges)}，单元格数值不会改变。`,
        confirmLabel: "删除规则",
        tone: "danger",
      }))
    )
      return;
    setBusy(true);
    try {
      if (
        !(await api.univerAPI.executeCommand(DeleteCfCommand.id, {
          unitId,
          subUnitId: sid,
          cfId: item.cfId,
        }))
      )
        throw new Error("未能删除规则");
    } catch (e) {
      toast({ tone: "error", title: e instanceof Error ? e.message : "删除失败" });
    } finally {
      setBusy(false);
    }
  };
  const rule = draft?.rule;
  return (
    <>
      <OverlayCardHeader
        title="条件格式"
        description={`${sheet.getSheetName()} · 规则随工作簿保存，可撤销`}
        icon={<Palette className="size-5" />}
      />
      <OverlayCardBody className="space-y-4">
        {!draft ? (
          <>
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">{rules.length} 条可识别规则</span>
              <Button size="sm" onClick={() => begin()} disabled={busy}>
                <Plus className="size-4" />
                新增规则
              </Button>
            </div>
            {rules.length === 0 && (
              <p className="py-6 text-center text-sm text-muted-foreground">
                选择区域后新增色阶、数据条或图标集
              </p>
            )}
            {rules.map((item) => (
              <div key={item.cfId} className="flex items-center gap-2 rounded-lg border p-3">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">
                    {kinds.find(([k]) => k === item.rule.type)?.[1] ?? "单元格高亮"}
                  </p>
                  <p className="truncate text-xs text-muted-foreground">
                    {rangesText(item.ranges)}
                  </p>
                </div>
                {visual(item.rule) && (
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`编辑规则 ${item.cfId}`}
                    onClick={() => begin(item)}
                    disabled={busy}
                  >
                    <Pencil className="size-4" />
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`删除规则 ${item.cfId}`}
                  onClick={() => void remove(item)}
                  disabled={busy}
                >
                  <Trash2 className="size-4" />
                </Button>
              </div>
            ))}
            <p className="text-xs text-muted-foreground">
              未识别的 Excel 扩展规则仍保留在文件中，不在这里编辑。
            </p>
            <div className="flex justify-end">
              <Button variant="outline" onClick={onClose}>
                完成
              </Button>
            </div>
          </>
        ) : (
          <>
            <Choice
              label="条件格式类型"
              value={rule?.type ?? "colorScale"}
              options={kinds}
              onChange={(kind) => setDraft((d) => (d ? { ...d, rule: defaults(kind as Kind) } : d))}
            />
            <label htmlFor={`${fieldId}-range`} className="block space-y-1 text-xs">
              应用区域
              <Input
                id={`${fieldId}-range`}
                aria-label="条件格式区域"
                value={range}
                onChange={(e) => setRange(e.target.value)}
                placeholder="A1:A10，多个区域用空格分隔"
              />
            </label>
            {rule?.type === CFRuleType.colorScale && (
              <>
                <div className="flex gap-2">
                  <Choice
                    label="色阶数量"
                    value={String(rule.config.length)}
                    options={[
                      ["2", "双色"],
                      ["3", "三色"],
                    ]}
                    onChange={(v) =>
                      change((r) => {
                        if (r.type !== CFRuleType.colorScale) return;
                        if (v === "2")
                          r.config = [
                            r.config[0]!,
                            { ...r.config[r.config.length - 1]!, index: 1 },
                          ];
                        else
                          r.config = [
                            r.config[0]!,
                            {
                              index: 1,
                              color: "#FFEB84",
                              value: { type: CFValueType.percentile, value: 50 },
                            },
                            { ...r.config[r.config.length - 1]!, index: 2 },
                          ];
                      })
                    }
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      change((r) => {
                        if (r.type === CFRuleType.colorScale) {
                          const colors = r.config.map((c) => c.color).reverse();
                          r.config.forEach((c, i) => {
                            c.color = colors[i]!;
                          });
                        }
                      })
                    }
                  >
                    反转颜色
                  </Button>
                </div>
                <div
                  className="h-4 rounded"
                  style={{
                    background: `linear-gradient(to right, ${rule.config.map((c) => (/^#[0-9a-f]{6}$/i.test(c.color) ? c.color : "transparent")).join(",")})`,
                  }}
                />
                {rule.config.map((point, i) => (
                  <div key={point.index} className="space-y-2 rounded-lg border p-3">
                    <Threshold
                      label={
                        i === 0 ? "最小端" : i === rule.config.length - 1 ? "最大端" : "中间端"
                      }
                      value={point.value}
                      onChange={(v) =>
                        change((r) => {
                          if (r.type === CFRuleType.colorScale) r.config[i]!.value = v;
                        })
                      }
                    />
                    <Color
                      label={`色阶颜色 ${i + 1}`}
                      value={point.color}
                      onChange={(v) =>
                        change((r) => {
                          if (r.type === CFRuleType.colorScale) r.config[i]!.color = v;
                        })
                      }
                    />
                  </div>
                ))}
              </>
            )}
            {rule?.type === CFRuleType.dataBar && (
              <>
                <Threshold
                  label="最小端"
                  value={rule.config.min}
                  onChange={(v) =>
                    change((r) => {
                      if (r.type === CFRuleType.dataBar) r.config.min = v;
                    })
                  }
                />
                <Threshold
                  label="最大端"
                  value={rule.config.max}
                  onChange={(v) =>
                    change((r) => {
                      if (r.type === CFRuleType.dataBar) r.config.max = v;
                    })
                  }
                />
                <Color
                  label="数据条颜色"
                  value={rule.config.positiveColor}
                  onChange={(v) =>
                    change((r) => {
                      if (r.type === CFRuleType.dataBar) {
                        r.config.positiveColor = v;
                        r.config.nativeColor = v;
                      }
                    })
                  }
                />
                <p className="text-xs text-muted-foreground">
                  使用 Excel 标准渐变数据条，正负数共用所选颜色。
                </p>
              </>
            )}
            {rule?.type === CFRuleType.iconSet && (
              <>
                <div className="flex gap-2">
                  <Choice
                    label="图标样式"
                    value={rule.config[0]?.iconType ?? "3Arrows"}
                    options={icons}
                    onChange={(v) =>
                      change((r) => {
                        if (r.type === CFRuleType.iconSet) r.config = iconConfig(v as IIconSetType);
                      })
                    }
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      change((r) => {
                        if (r.type === CFRuleType.iconSet) {
                          const ids = r.config.map((c) => c.iconId).reverse();
                          r.config.forEach((c, i) => {
                            c.iconId = ids[i]!;
                          });
                        }
                      })
                    }
                  >
                    反转图标
                  </Button>
                </div>
                <div className="flex items-center gap-2" aria-label="图标顺序预览">
                  {rule.config.map((c, i) => (
                    <img
                      key={i}
                      src={iconMap[c.iconType]?.[Number(c.iconId)]}
                      alt={`等级 ${i + 1}`}
                      className="size-5"
                    />
                  ))}
                </div>
                {rule.config.slice(0, -1).map((point, i) => (
                  <div key={i} className="space-y-2 rounded-lg border p-3">
                    <Threshold
                      label={`阈值 ${i + 1}`}
                      value={point.value}
                      onChange={(v) =>
                        change((r) => {
                          if (r.type === CFRuleType.iconSet) r.config[i]!.value = v;
                        })
                      }
                    />
                    <Choice
                      label={`阈值 ${i + 1}比较`}
                      value={point.operator}
                      options={[
                        ["greaterThanOrEqual", "大于等于"],
                        ["greaterThan", "大于"],
                      ]}
                      onChange={(v) =>
                        change((r) => {
                          if (r.type === CFRuleType.iconSet)
                            r.config[i]!.operator = v as CFNumberOperator;
                        })
                      }
                    />
                  </div>
                ))}
                <p className="text-xs text-muted-foreground">
                  阈值从高到低填写；其余数值使用最后一个图标。
                  {rule.config[0]?.iconId === "0" ? "正常顺序" : "已反转"}
                </p>
              </>
            )}
            {(rule?.type === CFRuleType.dataBar || rule?.type === CFRuleType.iconSet) && (
              <label htmlFor={`${fieldId}-show`} className="flex items-center gap-2 text-sm">
                <Checkbox
                  id={`${fieldId}-show`}
                  checked={rule.isShowValue}
                  onCheckedChange={(v) =>
                    change((r) => {
                      if (r.type === CFRuleType.dataBar || r.type === CFRuleType.iconSet)
                        r.isShowValue = v === true;
                    })
                  }
                />
                同时显示数值
              </label>
            )}
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Button variant="outline" disabled={busy} onClick={() => setDraft(null)}>
                取消编辑
              </Button>
              <Button disabled={busy} onClick={() => void save()}>
                {busy ? "正在应用…" : "保存规则"}
              </Button>
            </div>
          </>
        )}
      </OverlayCardBody>
    </>
  );
}
