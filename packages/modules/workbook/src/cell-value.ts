import type { ICellData } from "@univerjs/core";

/** Univer stores calculated booleans as 0/1 with the BOOLEAN cell type. */
export function scalarValue(cell: ICellData | undefined): ICellData["v"] {
  return cell?.t === 3 && (cell.v === 0 || cell.v === 1) ? cell.v === 1 : cell?.v;
}
