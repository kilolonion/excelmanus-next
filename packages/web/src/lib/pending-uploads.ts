export interface PendingUpload {
  id: string;
  scope: string;
  workspaceId: string;
  directory?: string;
  image: boolean;
  file: File;
}
const DB = "excelmanus.pending-uploads";
function openUploads(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("此浏览器不支持本地附件草稿"));
      return;
    }
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore("uploads", { keyPath: "id" });
      store.createIndex("scope", "scope");
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("本地附件草稿被其他标签页占用"));
  });
}
async function transaction<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await openUploads();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction("uploads", mode);
      const request = run(tx.objectStore("uploads"));
      tx.oncomplete = () => resolve(request.result);
      tx.onerror = () => reject(tx.error ?? request.error);
      tx.onabort = () => reject(tx.error ?? new Error("本地附件草稿保存中断"));
    });
  } finally {
    db.close();
  }
}
/** Materialize native file bytes so recovery does not depend on a temporary file handle. */
export async function snapshotUploadFile(file: File): Promise<File> {
  const bytes = await file.arrayBuffer();
  if (bytes.byteLength !== file.size) throw new Error("附件内容不完整，请重新选择原文件");
  return new File([bytes], file.name, { type: file.type, lastModified: file.lastModified });
}
export async function savePendingUpload(value: PendingUpload): Promise<boolean> {
  try {
    await transaction("readwrite", (s) => s.put(value));
    return true;
  } catch {
    return false;
  }
}
export async function removePendingUpload(id: string): Promise<void> {
  try {
    await transaction("readwrite", (s) => s.delete(id));
  } catch {
    /* metadata prevents resurrection */
  }
}
export async function readPendingUploads(scope: string): Promise<PendingUpload[]> {
  const records: unknown[] = await transaction("readonly", (s) => s.index("scope").getAll(scope));
  return records.filter(
    (r): r is PendingUpload =>
      !!r &&
      typeof r === "object" &&
      "id" in r &&
      typeof r.id === "string" &&
      "scope" in r &&
      r.scope === scope &&
      "workspaceId" in r &&
      typeof r.workspaceId === "string" &&
      "file" in r &&
      r.file instanceof Blob,
  );
}
