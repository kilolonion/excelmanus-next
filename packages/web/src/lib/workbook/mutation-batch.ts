import type { DocMutation } from "./doc-sync";

/** A synchronous editor command emits several mutations in one coordinate frame.
 * Sending them separately makes later siblings rebase through their own structural edit.
 */
export class EditorMutationBatch {
  private items: DocMutation[] = [];
  private revision: number | undefined;
  private queued = false;
  private readonly send: (items: DocMutation[], revision: number) => void;
  constructor(send: (items: DocMutation[], revision: number) => void) {
    this.send = send;
  }
  push(mutation: DocMutation, revision: number): void {
    if (this.items.length && this.revision !== revision) this.flush();
    this.revision = revision;
    this.items.push(structuredClone(mutation));
    if (this.queued) return;
    this.queued = true;
    queueMicrotask(() => {
      this.queued = false;
      this.flush();
    });
  }
  flush(): void {
    const items = this.items;
    const revision = this.revision;
    this.items = [];
    this.revision = undefined;
    if (items.length && revision !== undefined) this.send(items, revision);
  }
}
