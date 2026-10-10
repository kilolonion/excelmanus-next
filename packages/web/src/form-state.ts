type FormField = { name?: string; type?: string; value?: unknown; checked?: boolean };
/** Stable signatures are in memory only. Never log or persist field values or credentials. */
export function formSignature(fields: Iterable<FormField>): string {
  return JSON.stringify(
    [...fields]
      .filter((f) => !["submit", "button", "reset"].includes(f.type ?? ""))
      .map((f) => [
        f.name ?? "",
        f.type ?? "",
        f.type === "checkbox" || f.type === "radio" ? !!f.checked : (f.value ?? ""),
      ]),
  );
}
