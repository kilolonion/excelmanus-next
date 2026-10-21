import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BACKUPS_MIGRATION,
  BackupService,
  createReadTable,
  FileOperationError,
  openDb,
  type ToolContext,
} from "@excelmanus/kernel";
import { strToU8, unzipSync, zipSync } from "fflate";
import { expect, test } from "vitest";
import { CFB, utils, write } from "xlsx";
import {
  CHECKPOINT_MIGRATION,
  DOC_MOVES_MIGRATION,
  DOC_OPS_MIGRATION,
  DOC_OPS_REVERTS_MIGRATION,
  DOCUMENTS_MIGRATION,
  DocumentService,
  UnsupportedDocError,
} from "../src/service.ts";
import { workbookTools } from "../src/tools.ts";
import { importXlsx, XlsxImportError } from "../src/xlsx.ts";

const book = utils.book_new();
utils.book_append_sheet(
  book,
  utils.aoa_to_sheet([
    ["标识", "值"],
    ["001", 12],
  ]),
  "数据",
);
const valid = write(book, { type: "buffer", bookType: "xlsx" }) as Uint8Array;
const legacy = write(book, { type: "buffer", bookType: "biff8" }) as Uint8Array;
// 合成工作簿经 msoffcrypto-tool 6.0.0 实际加密生成；测试仅识别容器，不读取密码或解密。
const encrypted = Buffer.from(
  readFileSync(new URL("./fixtures/encrypted.xlsx.base64", import.meta.url), "utf8"),
  "base64",
);
const brokenXml = unzipSync(valid);
brokenXml["xl/worksheets/sheet1.xml"] = strToU8("<worksheet><sheetData>");
const badUtf8 = unzipSync(valid);
badUtf8["xl/workbook.xml"] = new Uint8Array([0xff, 0xfe]);

const rejected = [
  { path: "encrypted.xlsx", bytes: encrypted, code: "UNSUPPORTED_FEATURE", hint: /已加密.*不支持/ },
  {
    path: "truncated.xlsx",
    bytes: valid.subarray(0, valid.length - 50),
    code: "INVALID_ARGUMENT",
    hint: /损坏.*ZIP/,
  },
  {
    path: "broken-xml.xlsx",
    bytes: zipSync(brokenXml),
    code: "INVALID_ARGUMENT",
    hint: /XML.*无法解析/,
  },
  {
    path: "bad-utf8.xlsx",
    bytes: zipSync(badUtf8),
    code: "INVALID_ARGUMENT",
    hint: /XML.*无法解析/,
  },
  { path: "legacy.xls", bytes: legacy, code: "UNSUPPORTED_FEATURE", hint: /界面.*导入为新 .xlsx/ },
];

test("encrypted fixture has real Office encryption streams, not only an OLE header", () => {
  const compound = CFB.read(encrypted, { type: "buffer" });
  expect(CFB.find(compound, "EncryptionInfo")).toMatchObject({ type: 2 });
  expect(CFB.find(compound, "EncryptedPackage").size).toBeGreaterThan(8);
  expect(CFB.find(CFB.read(legacy, { type: "buffer" }), "EncryptedPackage")).toBeNull();
});

test.each(rejected)(
  "workbook_read gives an actionable input error for $path without writes",
  async (input) => {
    const root = mkdtempSync(join(tmpdir(), "abnormal-import-"));
    const db = openDb(":memory:", [
      DOCUMENTS_MIGRATION,
      DOC_OPS_MIGRATION,
      BACKUPS_MIGRATION,
      CHECKPOINT_MIGRATION,
      DOC_MOVES_MIGRATION,
      DOC_OPS_REVERTS_MIGRATION,
    ]);
    const service = new DocumentService(db);
    const ctx: ToolContext = {
      workspaceId: "ws1",
      workspaceRoot: root,
      signal: AbortSignal.timeout(10_000),
      sessionId: "ses1",
      agentId: "main",
      toolCallId: "tc1",
      role: "main",
      reads: createReadTable(),
      backups: new BackupService(db).bind({
        workspaceId: "ws1",
        workspaceRoot: root,
        sessionId: "ses1",
        agentId: "main",
      }),
    };
    try {
      writeFileSync(join(root, input.path), input.bytes);
      const read = workbookTools(service).find((tool) => tool.name === "workbook_read");
      if (!read) throw new Error("workbook_read 工具未注册");
      const result = await read.execute({ path: input.path, mode: "overview" }, ctx);
      expect(result).toMatchObject({
        status: "error",
        error: { code: input.code, retryable: false, message: expect.stringMatching(input.hint) },
      });
      expect(db.prepare("SELECT count(*) AS n FROM documents").get()).toMatchObject({ n: 0 });
      expect(db.prepare("SELECT count(*) AS n FROM doc_ops").get()).toMatchObject({ n: 0 });
      expect(readdirSync(root)).toEqual([input.path]);
      expect(readFileSync(join(root, input.path))).toEqual(Buffer.from(input.bytes));
    } finally {
      await service.close();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test("legacy hint describes the actual UI conversion copy, not a model tool", () => {
  const error = new UnsupportedDocError("legacy.xls");
  expect(error).toBeInstanceOf(FileOperationError);
  expect(error.message).toMatch(/界面.*导入为新 .xlsx/);
  expect(error.message).toContain("原文件保持不变");
  expect(error.message).toContain("有损");
  expect(error.message).toContain("不是模型可调用的工具");
  expect(new UnsupportedDocError("other.pdf").message).toContain(".xlsx/.xlsm/.csv/.tsv");
});

test("non-encrypted OLE is not mislabeled as an encrypted workbook", () => {
  try {
    importXlsx(legacy, "not-an-xlsx.xlsx");
    expect.fail("legacy OLE is not an OOXML workbook");
  } catch (error) {
    expect(error).toBeInstanceOf(XlsxImportError);
    expect(error).toBeInstanceOf(FileOperationError);
    expect(error).toMatchObject({ code: "INVALID_ARGUMENT" });
    expect((error as Error).message).not.toContain("加密");
  }
});
