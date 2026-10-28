/** Large previews retain offsets, materializing strings only for requested lines. */
export interface TextLines {
  length: number;
  get(index: number): string | undefined;
}

export function createTextLines(content: string): TextLines {
  if (content.length < 1_000_000) {
    const lines = content.split("\n");
    return { length: lines.length, get: (index) => lines[index] };
  }
  // Fixed-size blocks avoid a counting pass and retain compact offsets, not line strings.
  const blockSize = 4096;
  const starts = [new Uint32Array(blockSize)];
  let count = 1;
  for (let end = content.indexOf("\n"); end >= 0; end = content.indexOf("\n", end + 1)) {
    const block = Math.floor(count / blockSize);
    starts[block] ??= new Uint32Array(blockSize);
    starts[block][count % blockSize] = end + 1;
    count++;
  }
  const offset = (index: number) => starts[Math.floor(index / blockSize)][index % blockSize];
  return {
    length: count,
    get(index) {
      if (!Number.isInteger(index) || index < 0 || index >= count) return undefined;
      return content.slice(
        offset(index),
        index + 1 < count ? offset(index + 1) - 1 : content.length,
      );
    },
  };
}
