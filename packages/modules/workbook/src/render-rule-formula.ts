import type { IWorksheetData } from "@univerjs/core";

type Scalar = string | number | boolean | null;
type Eval = (r: number, c: number) => Scalar | undefined;
type Origin = { startRow: number; startColumn: number };

// A deliberately bounded read-only predicate grammar, not an Excel formula engine.
// Unknown functions, ranges and external references return no evaluator so callers
// can disclose the missing rendering rather than invent a result.
export function renderRuleFormula(
  source: string,
  sheet: IWorksheetData,
  origin: Origin,
): Eval | undefined {
  const tokens =
    source
      .replace(/^=/, "")
      .match(
        /"(?:[^"]|"")*"|\$?[A-Z]+\$?[1-9]\d*|(?:\d+(?:\.\d*)?|\.\d+)(?:E[+-]?\d+)?|[A-Z]+|<>|>=|<=|[=<>(),+-]|\S/gi,
      ) ?? [];
  let at = 0;
  const take = () => tokens[at++];
  const fail = () => {
    throw new Error("Unsupported rendering predicate");
  };
  const truth = (v: Scalar | undefined) =>
    typeof v === "boolean" ? v : typeof v === "number" ? v !== 0 : undefined;
  function atom(): Eval {
    const token = take();
    if (!token) return fail();
    if (/^"(?:[^"]|"")*"$/.test(token)) {
      const value = token.slice(1, -1).replaceAll('""', '"');
      return () => value;
    }
    if (/^(?:\d|\.)/.test(token)) {
      const value = Number(token);
      if (!Number.isFinite(value)) return fail();
      return () => value;
    }
    if (token === "+" || token === "-") {
      const value = atom();
      return (r, c) => {
        const v = value(r, c);
        return typeof v === "number" ? (token === "-" ? -v : v) : undefined;
      };
    }
    const ref = /^(\$?)([A-Z]+)(\$?)([1-9]\d*)$/i.exec(token);
    if (ref) {
      const column =
        [...ref[2]!.toUpperCase()].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
      const row = Number(ref[4]) - 1;
      return (r, c) => {
        const rr = row + (ref[3] ? 0 : r - origin.startRow);
        const cc = column + (ref[1] ? 0 : c - origin.startColumn);
        if (rr < 0 || cc < 0 || rr >= 1048576 || cc >= 16384) return undefined;
        const cell = sheet.cellData?.[rr]?.[cc];
        if (
          cell?.f &&
          (cell.v == null ||
            (typeof cell.v === "string" &&
              /^#(?:REF!|VALUE!|DIV\/0!|N\/A|NAME\?|NUM!|NULL!|SPILL!|CALC!)/.test(cell.v)))
        )
          return undefined;
        const value = cell?.v;
        if (cell?.t === 3) return value === true || value === 1;
        return value == null
          ? null
          : typeof value === "string" || typeof value === "number" || typeof value === "boolean"
            ? value
            : undefined;
      };
    }
    if (/^(TRUE|FALSE)$/i.test(token)) return () => token.toUpperCase() === "TRUE";
    if (token === "(") {
      const inner = expression();
      if (take() !== ")") return fail();
      return inner;
    }
    if (!/^(AND|OR|NOT|ISNUMBER)$/i.test(token) || take() !== "(") return fail();
    const args = [expression()];
    while (tokens[at] === ",") {
      at++;
      args.push(expression());
    }
    if (take() !== ")" || (/^(NOT|ISNUMBER)$/i.test(token) && args.length !== 1)) return fail();
    if (token.toUpperCase() === "ISNUMBER")
      return (r, c) => {
        const value = args[0]?.(r, c);
        return value === undefined ? undefined : typeof value === "number";
      };
    return (r, c) => {
      const values = args.map((arg) => truth(arg(r, c)));
      if (values.includes(undefined)) return undefined;
      return token.toUpperCase() === "AND"
        ? values.every(Boolean)
        : token.toUpperCase() === "OR"
          ? values.some(Boolean)
          : !values[0];
    };
  }
  function expression(): Eval {
    const left = atom();
    const op = tokens[at];
    if (!op || !/^(=|<>|>=|<=|>|<)$/.test(op)) return left;
    at++;
    const right = atom();
    return (r, c) => {
      let a = left(r, c),
        b = right(r, c);
      if (a === undefined || b === undefined) return undefined;
      // Excel compares an empty cell as zero, empty text or FALSE by counterpart.
      if (a === null) a = typeof b === "string" ? "" : typeof b === "boolean" ? false : 0;
      if (b === null) b = typeof a === "string" ? "" : typeof a === "boolean" ? false : 0;
      if (typeof a === "string") a = a.toUpperCase();
      if (typeof b === "string") b = b.toUpperCase();
      const rank = (v: Scalar) => (typeof v === "number" ? 0 : typeof v === "string" ? 1 : 2);
      const order = typeof a !== typeof b ? rank(a) - rank(b) : a === b ? 0 : a < b ? -1 : 1;
      return op === "="
        ? order === 0
        : op === "<>"
          ? order !== 0
          : op === ">"
            ? order > 0
            : op === "<"
              ? order < 0
              : op === ">="
                ? order >= 0
                : order <= 0;
    };
  }
  try {
    const evaluate = expression();
    return at === tokens.length ? (r, c) => truth(evaluate(r, c)) : undefined;
  } catch {
    return undefined;
  }
}
