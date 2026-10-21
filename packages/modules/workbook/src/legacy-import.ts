import { readFileSync } from "node:fs";
import { extname } from "node:path";
import { atomicWrite, FileOperationError, resolveWorkspacePath } from "@excelmanus/kernel";
import { read, write } from "xlsx";
import { importXlsx } from "./xlsx.ts";

/** One-way conversion only. The legacy source is never a live document or overwritten. */
export function importLegacyFile(root: string, source: string, destination: string) {
  const from = resolveWorkspacePath(root, source);
  const to = resolveWorkspacePath(root, destination);
  if (
    ![".xls", ".xlsb"].includes(extname(from.rel).toLowerCase()) ||
    extname(to.rel).toLowerCase() !== ".xlsx"
  )
    throw new FileOperationError(
      "INVALID_ARGUMENT",
      "请选择 .xls / .xlsb 源文件及新的 .xlsx 目标路径",
    );
  const bytes = readFileSync(from.abs);
  if (bytes.length > 50 * 1024 * 1024)
    throw new FileOperationError("INVALID_ARGUMENT", "旧格式导入最大支持 50 MB 文件");
  let workbook: ReturnType<typeof read>;
  try {
    workbook = read(bytes, {
      type: "buffer",
      cellNF: true,
      cellStyles: true,
      cellFormula: true,
      bookVBA: true,
    });
  } catch {
    throw new FileOperationError(
      "INVALID_ARGUMENT",
      "旧格式文件无法读取，可能已加密或损坏；请在 Excel 中解密后另存",
    );
  }
  if (!workbook.SheetNames.length)
    throw new FileOperationError("INVALID_ARGUMENT", "文件不包含可导入的工作表");
  const warnings = [
    "这是有损转换副本：保留可解析的值、公式、数字格式、合并区域和行列尺寸；字体、边框、填充等外观可能变化。",
    "图表、图片、宏、数据透视表、条件格式、数据验证与其他高级对象不保证保留，请使用原文件核对。",
  ];
  if (workbook.vbaraw) warnings.push("检测到 VBA 宏：新 .xlsx 不包含宏，原文件保持不变。");
  delete workbook.vbaraw;
  const output = write(workbook, {
    type: "buffer",
    bookType: "xlsx",
    cellStyles: true,
    compression: true,
  }) as Buffer;
  // Only publish a result our actual workbook engine can open.
  importXlsx(output, to.rel);
  atomicWrite(root, to.rel, output, null);
  return { path: to.rel, size: output.length, warnings };
}
