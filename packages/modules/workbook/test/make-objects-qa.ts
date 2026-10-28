// Creates a bounded QA workbook with native charts and embedded PNG; never overwrites.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { importCsv } from "../src/csv.ts";
import { minimalXlsx } from "../src/checkpoint.ts";
const root=process.argv[2]; if(!root)throw new Error("Provide QA output directory");
const snapshot=importCsv(new TextEncoder().encode("地区,销售,利润\n东,30,8\n西,20,5\n南,40,12\n"),"qa.csv").snapshot;
const source=snapshot.sheets[snapshot.sheetOrder[0]!]!;
snapshot.sheets={};snapshot.sheetOrder=[];
for(const type of ['column','bar','line','pie','doughnut','scatter','area','combo']) {
 const sheet=structuredClone(source);sheet.id=`qa-${type}`;sheet.name=type;sheet.rowCount=100;sheet.columnCount=30;
 sheet.custom={excelmanusObjects:{charts:[{id:`chart-${type}`,type,title:`QA ${type}`,range:type==='scatter'?'B1:C4':type==='pie'||type==='doughnut'?'A1:B4':'A1:C4',anchor:'E2',width:500,height:300}],images:[{id:'qa-image',title:'QA 蓝绿图片',anchor:'E18',width:240,height:120,mediaType:'image/png',data:'iVBORw0KGgoAAAANSUhEUgAAAPAAAAB4CAIAAABD1OhwAAAB3UlEQVR4nO3SQQ2AMADAwD0RhxBcIAB9+JmLLekuqYPeuN5HC7q/Xwsa208f0vbThwQ00KmABjoV0ECnAhroVEADnQpooFMBDXQqoIFOBTTQqYAGOhXQQKcCGuhUQAOdCmigUwENdCqggU4FNNCpgAY6FdBApwIa6FRAA50KaKBTAQ10KqCBTgU00KmABjoV0ECnAhroVEADnQpooFMBDXQqoIFOBTTQqYAGOhXQQKcCGuhUQAOdCmigUwENdCqggU4FNNCpgAY6FdBApwIa6FRAA50KaKBTAQ10KqCBTgU00KmABjoV0ECnAhroVEADnQpooFMBDXQqoIFOBTTQqYAGOhXQQKcCGuhUQAOdCmigUwENdCqggU4FNNCpgAY6FdBApwIa6FRAA50KaKBTAQ10KqCBTgU00KmABjoV0ECnAhroVEADnQpooFMBDXQqoIFOBTTQqYAGOhXQQKcCGuhUQAOdCmigUwENdCqggU4FNNCpgAY6FdBApwIa6FRAA50KaKBTAQ10KqCBTgU00KmABjoV0ECnAhroVEADnQpooFMBDXQqoIFOBTTQqYAGOhXQQKcCGuhUQAOdCmigUwENdCqggU4FNNCpgAY6FdBApwIa6FRAA50KaKBTTUjxl0/UY/yCAAAAAElFTkSuQmCC'}]}};
 snapshot.sheets[sheet.id]=sheet;snapshot.sheetOrder.push(sheet.id);
}
const path=join(root,'qa-dot-20261013-objects.xlsx');
writeFileSync(path,minimalXlsx(snapshot),{flag:'wx'});console.log(path);
