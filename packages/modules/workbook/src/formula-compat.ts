// New Excel functions require OOXML compatibility names even when the native engine
// uses their short names. Never rewrite quoted text or quoted sheet identifiers.
const names: Record<string, string> = {
  XLOOKUP: "_xlfn.XLOOKUP",
  FILTER: "_xlfn._xlws.FILTER",
  UNIQUE: "_xlfn.UNIQUE",
};
function mapFunctions(formula: string, exported: boolean): string {
  return formula
    .split(/("(?:[^"]|"")*"|'(?:[^']|'')*'|\[(?:'[\s\S]|[^\]])*\])/)
    .map((part, i) =>
      i % 2
        ? part
        : part.replace(
            /(?<![\p{L}\p{N}\p{M}_.\\])(?:_xlfn\.(?:_xlws\.)?)?(XLOOKUP|FILTER|UNIQUE)(?=\s*\()/giu,
            (_token, name: string) => (exported ? names[name.toUpperCase()]! : name.toUpperCase()),
          ),
    )
    .join("");
}
export const xlsxFormula = (formula: string): string => mapFunctions(formula, true);
export const engineFormula = (formula: string): string => mapFunctions(formula, false);

// Array imports already supported other future functions (e.g. SEQUENCE).
// Strip their prefix only at call tokens, not inside formula text or references.
export function engineArrayFormula(formula: string): string {
  return formula
    .split(/("(?:[^"]|"")*"|'(?:[^']|'')*'|\[(?:'[\s\S]|[^\]])*\])/)
    .map((part, i) =>
      i % 2
        ? part
        : part.replace(
            /(?<![\p{L}\p{N}\p{M}_.\\])_xlfn\.(?:_xlws\.)?(?=[\p{L}_][\p{L}\p{N}\p{M}_.]*\s*\()/giu,
            "",
          ),
    )
    .join("");
}
