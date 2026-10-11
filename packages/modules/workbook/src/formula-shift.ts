import { LexerTreeBuilder } from "@univerjs/preset-sheets-node-core";

const lexer = new LexerTreeBuilder();
/** Use the same formula lexer as calculation; never regex-rewrite cell names inside strings. */
export function shiftFormula(formula: string, columns: number, rows: number): string {
  return lexer.moveFormulaRefOffset(formula, columns, rows);
}
