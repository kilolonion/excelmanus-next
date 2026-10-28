import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import StreamingTextPreview from "../src/components/chat/StreamingTextPreview";
import "../src/app/globals.css";
function QA() {
 const [count,setCount]=useState(10000);
 const [tail,setTail]=useState("");
 const [kind,setKind]=useState("write");
 const content=Array.from({length:count},(_,i)=>`QA 第 ${i+1} 行: abc 中文 ${i===500?'LONG '.repeat(80):''}`).join("\n")+tail;
 return <main style={{maxWidth:800,margin:"40px auto"}}><h1>长文本预览受控测试</h1><p>仅合成内容，无业务接口。</p><button onClick={()=>setCount(c=>c+1)}>追加一行</button> <button onClick={()=>setTail(t=>t+"尾部增量")}>追加尾字</button> <button onClick={()=>setKind(k=>k==="write"?"edit":"write")}>切换写入/差异</button><StreamingTextPreview key={kind} toolName={kind} rawArgs={JSON.stringify(kind==="write"?{path:"qa.txt",content}:{path:"qa.txt",oldText:"OLD\n".repeat(1000),newText:content})}/></main>;
}
createRoot(document.getElementById("root")!).render(<QA/>);
