import { IDefinedNamesService } from "@univerjs/preset-sheets-core";
import { RemoveDefinedNameCommand, SetDefinedNameCommand } from "@univerjs/sheets";
import { BookA, ChevronDown, LocateFixed, Pencil, Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
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

type Name = {
  id: string;
  name: string;
  formulaOrRefString: string;
  localSheetId?: string;
  comment?: string;
  hidden?: boolean;
};
export function DefinedNames({ api, disabled }: { api: SheetApi | null; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        variant="ghost"
        size="icon"
        className="size-7 shrink-0"
        aria-label="名称管理器"
        title="名称管理器"
        disabled={disabled || !api}
        onClick={() => setOpen(true)}
      >
        <BookA className="size-4" />
      </Button>
      <OverlayCard open={open} onOpenChange={setOpen} size="lg">
        {open && api && <Manager api={api} close={() => setOpen(false)} />}
      </OverlayCard>
    </>
  );
}
function Manager({ api, close }: { api: SheetApi; close: () => void }) {
  const [loadedNames, setNames] = useState<Name[] | null>(null),
    [draft, setDraft] = useState<Name | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const sheets = api.wb.getSheets().map((sheet) => ({
    id: sheet.getSheetId(),
    name: sheet.getSheetName(),
  }));
  const sheetNames = new Map<string, string>();
  for (const sheet of sheets) if (!sheetNames.has(sheet.id)) sheetNames.set(sheet.id, sheet.name);
  const names = loadedNames ?? [];
  useEffect(() => {
    const read = () => {
      const data = api.univer
        .__getInjector()
        .get(IDefinedNamesService)
        .getDefinedNameMap(api.wb.getId());
      setNames(Object.values(data ?? {}).map((name) => ({ ...name })));
    };
    read();
    const refresh = createFrameRefresh(read);
    const sub = api.wb.onCommandExecuted((c) => {
      if (c.id.includes("defined-name")) refresh.schedule();
    });
    return () => {
      refresh.dispose();
      sub.dispose();
    };
  }, [api]);
  const scope = (n: Name) =>
    n.localSheetId && n.localSheetId !== "AllDefaultWorkbook" ? n.localSheetId : "";
  function begin(n?: Name) {
    setError("");
    const sheet = api.wb.getActiveSheet(),
      range = sheet?.getSelection()?.getActiveRange()?.getA1Notation() ?? "A1";
    setDraft(
      n
        ? { ...n }
        : {
            id: crypto.randomUUID(),
            name: "",
            formulaOrRefString: `'${sheet?.getSheetName().replaceAll("'", "''")}'!${range}`,
            localSheetId: "AllDefaultWorkbook",
          },
    );
  }
  async function save() {
    if (!draft) return;
    setError("");
    const n = {
      ...draft,
      name: draft.name.trim(),
      formulaOrRefString: draft.formulaOrRefString.trim().replace(/^=/, ""),
    };
    if (
      !/^[\p{L}_\\][\p{L}\p{N}_.\\]*$/u.test(n.name) ||
      n.name.length > 255 ||
      /^(?:[A-Z]{1,3}[1-9]\d*|R\d+C\d+|R|C)$/i.test(n.name)
    )
      return setError("名称需以文字或下划线开头，不能使用单元格地址。");
    if (!n.formulaOrRefString) return setError("请填写引用区域、常量或公式。");
    if (
      names.some(
        (x) =>
          x.id !== n.id && scope(x) === scope(n) && x.name.toLowerCase() === n.name.toLowerCase(),
      )
    )
      return setError("这个作用域中已有同名定义。");
    setBusy(true);
    try {
      if (
        !(await api.univerAPI.executeCommand(SetDefinedNameCommand.id, {
          ...n,
          unitId: api.wb.getId(),
        }))
      )
        throw Error("名称修改未成功");
      setDraft(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "保存失败");
    } finally {
      setBusy(false);
    }
  }
  async function remove(n: Name) {
    if (
      !(await confirmAction({
        title: `删除名称“${n.name}”？`,
        description: "引用此名称的公式可能显示 #NAME?。可通过撤销恢复。",
        confirmLabel: "删除名称",
        tone: "danger",
      }))
    )
      return;
    setBusy(true);
    try {
      if (
        !(await api.univerAPI.executeCommand(RemoveDefinedNameCommand.id, {
          unitId: api.wb.getId(),
          id: n.id,
        }))
      )
        throw Error("删除失败");
    } catch (e) {
      toast({ tone: "error", title: String(e) });
    } finally {
      setBusy(false);
    }
  }
  function locate(n: Name) {
    const m = /^(?:'((?:[^']|'')+)'|([^!]+))!([$A-Z0-9:]+)$/i.exec(
      n.formulaOrRefString.replace(/^=/, ""),
    );
    if (!m) {
      toast({ tone: "info", title: "此名称不是单一工作表区域，无法直接定位" });
      return;
    }
    const sheet = api.wb.getSheetByName((m[1]?.replaceAll("''", "'") ?? m[2])!);
    if (!sheet) return;
    close();
    api.wb.setActiveSheet(sheet);
    sheet.getRange(m[3]!.replaceAll("$", "")).activate();
  }
  return (
    <>
      <OverlayCardHeader
        title="名称管理器"
        description="名称与工作簿一起保存，可用于公式计算"
        icon={<BookA className="size-5" />}
      />
      <OverlayCardBody className="space-y-4">
        {draft ? (
          <>
            <label className="block space-y-1 text-xs">
              名称
              <Input
                aria-label="定义名名称"
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              />
            </label>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" aria-label="名称作用域">
                  {sheetNames.get(scope(draft)) ?? "工作簿"}
                  <ChevronDown className="size-3" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent>
                <DropdownMenuRadioGroup
                  value={scope(draft)}
                  onValueChange={(v) =>
                    setDraft({ ...draft, localSheetId: v || "AllDefaultWorkbook" })
                  }
                >
                  <DropdownMenuRadioItem value="">工作簿</DropdownMenuRadioItem>
                  {sheets.map((s) => (
                    <DropdownMenuRadioItem key={s.id} value={s.id}>
                      {s.name}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
            <label className="block space-y-1 text-xs">
              引用位置 / 公式
              <Input
                aria-label="定义名引用"
                value={draft.formulaOrRefString}
                onChange={(e) => setDraft({ ...draft, formulaOrRefString: e.target.value })}
              />
            </label>
            <label className="block space-y-1 text-xs">
              说明
              <Input
                aria-label="定义名说明"
                value={draft.comment ?? ""}
                onChange={(e) => setDraft({ ...draft, comment: e.target.value })}
              />
            </label>
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
                保存名称
              </Button>
            </div>
          </>
        ) : (
          <>
            <div className="flex justify-between items-center">
              <span className="text-sm text-muted-foreground">
                {loadedNames === null ? "正在读取名称…" : `${names.length} 个名称`}
              </span>
              <Button size="sm" disabled={loadedNames === null} onClick={() => begin()}>
                <Plus className="size-4" />
                新增名称
              </Button>
            </div>
            {names.map((n) => (
              <div key={n.id} className="flex items-center gap-2 rounded-lg border p-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">
                    {n.name}
                    <span className="ml-2 text-xs text-muted-foreground">
                      {sheetNames.get(scope(n)) ?? "工作簿"}
                    </span>
                  </p>
                  <p
                    className="truncate text-xs text-muted-foreground"
                    title={n.formulaOrRefString}
                  >
                    {n.formulaOrRefString}
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`定位名称 ${n.name}`}
                  onClick={() => locate(n)}
                >
                  <LocateFixed className="size-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`编辑名称 ${n.name}`}
                  disabled={busy}
                  onClick={() => begin(n)}
                >
                  <Pencil className="size-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`删除名称 ${n.name}`}
                  disabled={busy}
                  onClick={() => void remove(n)}
                >
                  <Trash2 className="size-4" />
                </Button>
              </div>
            ))}
            <div className="flex justify-end">
              <Button variant="outline" onClick={close}>
                完成
              </Button>
            </div>
          </>
        )}
      </OverlayCardBody>
    </>
  );
}
