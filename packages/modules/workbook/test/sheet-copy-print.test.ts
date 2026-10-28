import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKUPS_MIGRATION, openDb } from "@excelmanus/kernel";
import { unzipSync, zipSync } from "fflate";
import { expect, test } from "vitest";
import { minimalXlsx } from "../src/checkpoint.ts";
import { importCsv } from "../src/csv.ts";
import { ChangeOp } from "../src/ops.ts";
import {
  CHECKPOINT_MIGRATION,
  DOC_MOVES_MIGRATION,
  DOC_OPS_MIGRATION,
  DOC_OPS_REVERTS_MIGRATION,
  DOCUMENTS_MIGRATION,
  DocumentService,
} from "../src/service.ts";
import { importXlsx } from "../src/xlsx.ts";

for (const mode of ["plain", "printer", "prefixed"] as const) {
  const printer = mode === "printer";
  test(
    printer
      ? "复制带打印机关系的工作表安全拒绝"
      : mode === "prefixed"
        ? "带前缀源打印复制与 legacy-only 快照兼容，重开后仍保留"
        : "复制工作表保留横向 A4 和 fitToPage，重开后再复制仍保留",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "excelmanus-copy-print-"));
      const db = openDb(join(dir, "db.sqlite"), [
        DOCUMENTS_MIGRATION,
        DOC_OPS_MIGRATION,
        BACKUPS_MIGRATION,
        CHECKPOINT_MIGRATION,
        DOC_MOVES_MIGRATION,
        DOC_OPS_REVERTS_MIGRATION,
      ]);
      let service = new DocumentService(db);
      try {
        const parts = unzipSync(
          minimalXlsx(
            importCsv(new TextEncoder().encode("数量,价格\n2,12.5\n"), "模板.csv").snapshot,
          ),
        );
        const path = "xl/worksheets/sheet1.xml";
        const pageSetup = `<pageSetup paperSize="9" orientation="landscape" fitToWidth="1" fitToHeight="0"${printer ? ' r:id="rIdPrinter"' : ""}/>`;
        const pageSetUpPr = '<pageSetUpPr fitToPage="1" autoPageBreaks="0"/>';
        parts[path] = new TextEncoder().encode(
          new TextDecoder()
            .decode(parts[path])
            .replace(/(<worksheet[^>]*>)/, `$1<sheetPr>${pageSetUpPr}</sheetPr>`)
            .replace("</worksheet>", `${pageSetup}</worksheet>`),
        );
        if (mode === "prefixed") {
          parts[path] = new TextEncoder().encode(
            new TextDecoder()
              .decode(parts[path])
              .replace(
                'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"',
                'xmlns:s="http://schemas.openxmlformats.org/spreadsheetml/2006/main"',
              )
              .replace(/<(\/?)([A-Za-z][\w]*)(?=[\s/>])/g, "<$1s:$2"),
          );
          const legacy = importXlsx(zipSync(parts), "legacy.xlsx").snapshot;
          for (const sheet of Object.values(legacy.sheets))
            if (sheet.custom) delete sheet.custom.excelmanusPrintSettings;
          const restored = unzipSync(minimalXlsx(legacy));
          const xml = new TextDecoder().decode(restored[path]);
          expect(xml).toContain(pageSetup);
          expect(xml).toContain(pageSetUpPr);
        }
        const original = zipSync(parts);
        writeFileSync(join(dir, "book.xlsx"), original);
        const opened = await service.open("w", dir, "book.xlsx");
        const id = opened.meta.id;
        const copy = async (sheet: string, name: string) =>
          service.submit(id, dir, {
            baseRev: (await service.snapshot(id, dir)).meta.rev,
            source: { kind: "agent", id: "main" },
            sessionId: "s",
            ops: [ChangeOp.parse({ op: "sheet.copy", sheet, name })],
          });
        const { snapshot } = await service.snapshot(id, dir);
        const source = snapshot.sheets[snapshot.sheetOrder[0]!]!.name!;
        const result = await copy(source, "Copy");
        if (printer) {
          expect(result).toMatchObject({ ok: false });
          expect(readFileSync(join(dir, "book.xlsx"))).toEqual(Buffer.from(original));
          return;
        }
        expect(result).toMatchObject({ ok: true });
        await service.checkpoint(id, dir);
        const check = (name: string) => {
          const imported = importXlsx(readFileSync(join(dir, "book.xlsx")), "book.xlsx");
          const sid = imported.snapshot.sheetOrder.find(
            (i) => imported.snapshot.sheets[i]?.name === name,
          )!;
          const xml = new TextDecoder().decode(
            imported.preservation!.parts[imported.preservation!.sheetParts[sid]!.path],
          );
          expect(xml).toContain(pageSetup);
          expect(xml).toContain(pageSetUpPr);
        };
        check("Copy");
        await service.close();
        service = new DocumentService(db);
        await service.open("w", dir, "book.xlsx");
        expect(await copy("Copy", "CopyAgain")).toMatchObject({ ok: true });
        await service.checkpoint(id, dir);
        check("CopyAgain");
      } finally {
        await service.close();
        db.close();
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
}
