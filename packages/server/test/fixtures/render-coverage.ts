import { createCanvas } from "@napi-rs/canvas";
import { minimalXlsx } from "../../../modules/workbook/src/checkpoint.ts";
import { importCsv } from "../../../modules/workbook/src/csv.ts";
import { CF_RESOURCE, setRulesResource } from "../../../modules/workbook/src/rule-codec.ts";

export async function renderCoverageWorkbook() {
  const {snapshot}=importCsv(new TextEncoder().encode("项目,金额,色阶,数据条,图标\n甲,10,10,10,10\n乙,25,25,25,25\n丙,18,18,18,18\n"),"coverage.csv");
  const sid=snapshot.sheetOrder[0]!,sheet=snapshot.sheets[sid]!;
  sheet.name="截图验收";sheet.rowCount=30;sheet.columnCount=16;
  for(let c=0;c<5;c++)sheet.cellData![0]![c]!.s={bl:1,bg:{rgb:"#d9eade"}};
  sheet.cellData![1]![1]!.s={bd:{b:{s:13,cl:{rgb:"#ff0000"}},r:{s:7,cl:{rgb:"#008080"}}}};
  const ranges=(c:number)=>[{startRow:1,endRow:3,startColumn:c,endColumn:c}];
  setRulesResource(snapshot,CF_RESOURCE,{[sid]:[
    {cfId:"color",ranges:ranges(2),rule:{type:"colorScale",config:[{index:0,color:"#ff0000",value:{type:"min"}},{index:1,color:"#00ff00",value:{type:"max"}}]}},
    {cfId:"bar",ranges:ranges(3),rule:{type:"dataBar",isShowValue:true,config:{min:{type:"min"},max:{type:"max"},isGradient:true,positiveColor:"#087f68",nativeColor:"#087f68"}}},
    {cfId:"icon",ranges:ranges(4),rule:{type:"iconSet",isShowValue:true,config:[0,1,2].map(i=>({operator:"greaterThanOrEqual",value:{type:"percent",value:(2-i)*33},iconType:"3Arrows",iconId:String(i)}))}}
  ]});
  const logo=createCanvas(120,50),ctx=logo.getContext("2d");ctx.fillStyle="#ff00ff";ctx.fillRect(0,0,120,50);ctx.fillStyle="#ffffff";ctx.font="bold 18px sans-serif";ctx.fillText("PNG 2468",10,32);
  sheet.custom={excelmanusObjects:{charts:[{id:"c",type:"column",title:"当前金额",range:"A1:B4",anchor:"B7",width:430,height:240}],images:[{id:"i",title:"嵌入图片",anchor:"G2",width:120,height:50,mediaType:"image/png",data:(await logo.encode("png")).toString("base64")}]}};
  return minimalXlsx(snapshot);
}
