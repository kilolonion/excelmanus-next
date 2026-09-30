// 只读表格工作台：文件列表 + 上传 + Univer 1.0.2 只读查看 + 选区上下文。

import { indexToCol } from "@excelmanus/core";
import type { IWorkbookData, Univer } from "@univerjs/core";
import { UniverSheetsCorePreset } from "@univerjs/preset-sheets-core";
import zhCN from "@univerjs/preset-sheets-core/locales/zh-CN";
import { createUniver, LocaleType, mergeLocales } from "@univerjs/presets";
import type { FWorkbook } from "@univerjs/sheets/facade";
import { useEffect, useRef, useState } from "react";
import { openWorkspaceFile, setSelection, uploadWorkspaceFile, useApp } from "../store.ts";
import { S } from "../strings.ts";

function UniverViewer() {
  const doc = useApp((s) => s.doc);
  const hostRef = useRef<HTMLDivElement>(null);
  const apiRef = useRef<{ univer: Univer; wb: FWorkbook } | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !doc) return;
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
    const wb = univerAPI.createWorkbook(structuredClone(doc.snapshot) as unknown as IWorkbookData);
    wb.setEditable(false);
    apiRef.current = { univer, wb };
    const sub = wb.onSelectionChange((selections) => {
      const sel = selections[0];
      const sheet = wb.getActiveSheet();
      if (!sel || !sheet) return;
      const name = sheet.getSheetName();
      const a1 = `${indexToCol(sel.startColumn + 1)}${sel.startRow + 1}:${indexToCol(sel.endColumn + 1)}${sel.endRow + 1}`;
      setSelection(`${name}!${a1}`);
    });
    return () => {
      sub.dispose();
      apiRef.current = null;
      univer.dispose();
    };
  }, [doc]);

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
          const openable = /\.(xlsx|csv)$/i.test(f.name);
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
