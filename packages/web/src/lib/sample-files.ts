/** 示例每次使用独立副本，避免与用户已编辑的同名文件冲突。 */
export function sampleCopies(files: File[], attemptId: string = crypto.randomUUID()): File[] {
  return files.map((file) => {
    const dot = file.name.lastIndexOf(".");
    const stem = dot > 0 ? file.name.slice(0, dot) : file.name;
    const ext = dot > 0 ? file.name.slice(dot) : "";
    return new File([file], `${stem}-示例-${attemptId}${ext}`, { type: file.type });
  });
}
