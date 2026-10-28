import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
export interface NoteContext { docId: string; sheetId: string; ref: string; text: string; author: string; revision: number; exists: boolean; }
export function CellNoteDialog({ context, onClose, onSave }: { context: NoteContext; onClose(): void; onSave(text: string | null, author: string): Promise<void> }) {
  const [text, setText] = useState(context.text), [author, setAuthor] = useState(context.author);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const save = async (remove: boolean) => {
    setBusy(true); setError("");
    try { await onSave(remove ? null : text, author); onClose(); }
    catch (e) { setError(e instanceof Error ? e.message : "批注保存失败"); }
    finally { setBusy(false); }
  };
  return <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
    <DialogContent>
      <DialogHeader><DialogTitle>{context.ref} 批注 / 备注</DialogTitle><DialogDescription>编辑传统 Excel 备注，保存到工作簿。可通过修订历史撤销。</DialogDescription></DialogHeader>
      <label className="grid gap-1 text-sm">作者<Input aria-label="批注作者" value={author} maxLength={500} onChange={(e) => setAuthor(e.target.value)} /></label>
      <label className="grid gap-1 text-sm">内容<Textarea aria-label="批注内容" value={text} maxLength={32767} className="min-h-32" onChange={(e) => setText(e.target.value)} /></label>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <DialogFooter>
        {context.exists && <Button variant="destructive" disabled={busy} onClick={() => void save(true)}>删除批注</Button>}
        <Button variant="outline" disabled={busy} onClick={onClose}>取消</Button>
        <Button disabled={busy || !text.trim()} onClick={() => void save(false)}>保存批注</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
