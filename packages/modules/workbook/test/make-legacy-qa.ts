// Generate two tiny QA files without replacing anything in the requested test directory.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { utils, write } from "xlsx";
const root = process.argv[2];
if (!root) throw new Error("Provide a QA output directory");
for (const type of ["biff8", "xlsb"] as const) {
 const book = utils.book_new();
 const sheet = utils.aoa_to_sheet([["项目", "数量", "单价"], ["苹果", 2, 3], ["梨", 4, 5]]);
 sheet.C2!.z = "0.00"; sheet.C3!.z = "0.00";
 utils.book_append_sheet(book, sheet, "导入测试");
 const path = join(root, `qa-dot-20261013-legacy.${type === "biff8" ? "xls" : "xlsb"}`);
 writeFileSync(path, write(book, {type:"buffer",bookType:type}), {flag:"wx"});
 console.log(path);
}
