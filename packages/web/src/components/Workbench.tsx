// 表格工作台：文件列表 + 上传 + Univer 1.0.2 编辑 + 选区上下文。

import { formatRange, parseRange } from "@excelmanus/core";
import { CommandType, type IWorkbookData, type Univer } from "@univerjs/core";
import { UniverSheetsCorePreset } from "@univerjs/preset-sheets-core";
import zhCN from "@univerjs/preset-sheets-core/locales/zh-CN";
import { createUniver, LocaleType, mergeLocales } from "@univerjs/presets";
import type { FWorkbook } from "@univerjs/sheets/facade";
import { useEffect, useRef, useState } from "react";
import {
  openWorkspaceFile,
  registerDocumentEditor,
  setSelection,
  submitDocumentMutation,
  uploadWorkspaceFile,
  useApp,
} from "../store.ts";
import { S } from "../strings.ts";

function UniverViewer() {
  const doc = useApp((s) => s.doc);
  const docId = doc?.docId;
  const snapshot = doc?.snapshot;
  const focus = useApp((s) => s.rangeFocus);
  const preview = useApp((s) => s.rangePreview);
  const hostRef = useRef<HTMLDivElement>(null);
  const apiRef = useRef<{ univer: Univer; wb: FWorkbook } | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !docId || !snapshot) return;
    const { univer, univerAPI } = createUniver({
      locale: LocaleType.ZH_CN,
      locales: { [LocaleType.ZH_CN]: mergeLocales(zhCN) },
      presets: [
        UniverSheetsCorePreset({
          container: host,
          header: false,
          toolbar: false,
          formulaBar: false,
          footer: false,
          contextMenu: false,
        }),
      ],
    });
    const wb = univerAPI.createWorkbook(structuredClone(snapshot) as unknown as IWorkbookData);
    // 工作台编辑与代理共用 doc.submit；服务端负责串行化与冲突判定。
    wb.setEditable(true);
    apiRef.current = { univer, wb };
    let applyingRemote = false;
    const bridge = {
      docId,
      applyRemote: async (mutations: Array<{ id: string; params: unknown }>) => {
        applyingRemote = true;
        try {
          for (const mutation of mutations) {
            const ok = await univerAPI.executeCommand(
              mutation.id,
              (mutation.params ?? {}) as object,
              { fromCollab: true },
            );
            if (!ok) throw new Error(`远端 mutation 未生效：${mutation.id}`);
          }
        } finally {
          applyingRemote = false;
        }
      },
    };
    registerDocumentEditor(bridge);
    const commandSub = wb.onCommandExecuted((command, options) => {
      if (applyingRemote || options?.fromCollab || options?.fromChangeset) return;
      if (command.type !== CommandType.MUTATION) return;
      void submitDocumentMutation(docId, {
        id: command.id,
        params: command.params ?? {},
      });
    });
    const sub = wb.onSelectionChange((selections) => {
      const sel = selections[0];
      const sheet = wb.getActiveSheet();
      if (!sel || !sheet) return;
      const name = sheet.getSheetName();
      setSelection(
        formatRange({
          sheet: name,
          startCol: sel.startColumn + 1,
          startRow: sel.startRow + 1,
          endCol: sel.endColumn + 1,
          endRow: sel.endRow + 1,
        }),
      );
    });
    return () => {
      commandSub.dispose();
      sub.dispose();
      registerDocumentEditor(null);
      apiRef.current = null;
      univer.dispose();
    };
  }, [docId, snapshot]);

  useEffect(() => {
    const wb = apiRef.current?.wb;
    if (!wb || !focus) return;
    const parsed = parseRange(focus.range);
    const sheet = parsed.sheet ? wb.getSheetByName(parsed.sheet) : wb.getActiveSheet();
    if (!sheet) return;
    wb.setActiveSheet(sheet);
    const range = sheet.getRange(
      parsed.startRow - 1,
      parsed.startCol - 1,
      parsed.endRow - parsed.startRow + 1,
      parsed.endCol - parsed.startCol + 1,
    );
    range.activate();
    sheet.scrollToCell(parsed.startRow - 1, parsed.startCol - 1);
    const highlight = range.highlight({ fill: "rgba(255, 200, 0, 0.25)" });
    const timer = setTimeout(() => highlight.dispose(), 2000);
    return () => {
      clearTimeout(timer);
      highlight.dispose();
    };
  }, [focus]);

  useEffect(() => {
    const wb = apiRef.current?.wb;
    if (!wb || !preview) return;
    try {
      const parsed = parseRange(preview);
      const sheet = wb.getActiveSheet();
      if (!sheet || (parsed.sheet && sheet.getSheetName() !== parsed.sheet)) return;
      const highlight = sheet
        .getRange(
          parsed.startRow - 1,
          parsed.startCol - 1,
          parsed.endRow - parsed.startRow + 1,
          parsed.endCol - parsed.startCol + 1,
        )
        .highlight({ strokeDash: 4 });
      return () => highlight.dispose();
    } catch {
      return;
    }
  }, [preview]);

  if (!doc) return <div className="doc-empty muted small">{S.openFileHint}</div>;
  return <div className="univer-host" ref={hostRef} />;
}

export function Workbench() {
  const files = useApp((s) => s.files);
  const doc = useApp((s) => s.doc);
  const selection = useApp((s) => s.selection);
  const [err, setErr] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  return (
    <div className="workbench-inner">
      <div className="row-between">
        <span className="section-title">{S.files}</span>
        <button type="button" className="btn ghost" onClick={() => fileInput.current?.click()}>
          {S.upload}
        </button>
        <input
          ref={fileInput}
          type="file"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (f) void uploadWorkspaceFile(f).catch(() => setErr(S.uploadFailed));
          }}
        />
      </div>
      {err && <div className="notice error small">{err}</div>}
      <div className="file-list">
        {files.map((f) => {
          const openable = /\.(xlsx|xlsm|csv|tsv)$/i.test(f.name);
          return (
            <button
              key={f.path}
              type="button"
              className={`file-item ${doc?.path === f.path ? "active" : ""}`}
              disabled={f.kind === "dir"}
              onClick={() => {
                if (!openable) {
                  setErr(S.unsupportedFile);
                  return;
                }
                setErr(null);
                void openWorkspaceFile(f.path).catch(() => setErr(S.docLoadFailed));
              }}
            >
              {f.kind === "dir" ? "📁 " : ""}
              {f.name}
            </button>
          );
        })}
      </div>
      {doc?.checkpointError && (
        <div className="notice error small">
          {S.checkpointFailed}: {doc.checkpointError}
        </div>
      )}
      <div className="doc-area">
        <UniverViewer />
      </div>
      <div className="selection-bar small muted">
        {S.selectedRange}：{selection?.range ?? S.noSelection}
        {doc ? `（${doc.path} rev ${doc.rev}）` : ""}
      </div>
    </div>
  );
}
