// 独立浏览器验收页，不连接后端，不进入产品入口。
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { LazyRegion } from "@/components/ui/LazyRegion";
import { Button } from "@/components/ui/button";
import "@/app/globals.css";

let release: (() => void) | undefined;
let attempts = 0;
function Ready() { return <p>局部内容已恢复</p>; }
const load = () => {
  attempts += 1;
  if (attempts > 1) return Promise.resolve({ default: Ready });
  return new Promise<{ default: typeof Ready }>((_resolve, reject) => {
    release = () => reject(new Error("QA simulated module download failure"));
  });
};
function App() {
  const [open, setOpen] = useState(true);
  const [dialog, setDialog] = useState(false);
  const [draft, setDraft] = useState("保留我的草稿");
  const [run, setRun] = useState(0);
  return <main className="p-6 space-y-4">
    <h1>局部加载恢复 QA</h1>
    <p>对话内容保持可见</p>
    <textarea aria-label="验收草稿" value={draft} onChange={(e) => setDraft(e.target.value)} className="border p-2" />
    <div className="flex gap-2">
      <Button onClick={() => release?.()}>模拟加载失败</Button>
      <Button onClick={() => { attempts = 0; setRun((n) => n + 1); setOpen(true); }}>重新开始等待</Button>
      <Button onClick={() => { setDialog(!dialog); attempts = 0; setRun((n) => n + 1); setOpen(true); }}>切换弹窗模式</Button>
    </div>
    {open ? <div className="border rounded-xl h-72"><LazyRegion key={run} load={load} componentProps={{}} label="验收区域" onClose={() => setOpen(false)} dialog={dialog} /></div> : <p>区域已关闭，草稿仍在</p>}
  </main>;
}
createRoot(document.getElementById("root")!).render(<App />);
