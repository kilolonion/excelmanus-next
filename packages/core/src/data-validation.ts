// OOXML uses string error styles; Univer's editor uses numeric enum values.
export function normalizeDataValidationRule(
  rule: Record<string, unknown>,
): Record<string, unknown> {
  const next = { ...rule };
  if (rule.type === "list" || rule.type === "custom") delete next.operator;
  const styles: Record<string, number> = { stop: 1, warning: 2, information: 0 };
  if (typeof rule.errorStyle === "string" && rule.errorStyle in styles)
    next.errorStyle = styles[rule.errorStyle];
  return next;
}

export function dataValidationXmlErrorStyle(style: unknown): string | undefined {
  if (style === 1 || style === "stop") return "stop";
  if (style === 2 || style === "warning") return "warning";
  if (style === 0 || style === "information") return "information";
  return undefined;
}
