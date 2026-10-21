// 凭据脱敏（10 §4、01 §5.3、AGENTS 红线 10）：解析档案/发请求时登记本进程用到的明文凭据，
// 错误文本与会话日志写入前按精确值替换；错误文本另按常见密钥格式正则兜底。

const REDACTED = "<redacted>";
/** 过短的值精确替换会误伤正常文本（如 "none"），不登记。 */
const MIN_SECRET_LENGTH = 8;
const secrets = new Set<string>();
/** 长者优先，避免短值先替换后残留长值片段。 */
let ordered: string[] = [];

export function registerSecret(value: string | undefined | null): void {
  if (typeof value !== "string") return;
  const v = value.trim();
  if (v.length < MIN_SECRET_LENGTH || secrets.has(v)) return;
  secrets.add(v);
  ordered = [...secrets].sort((a, b) => b.length - a.length);
}

/** 登记一次请求用到的全部明文：apiKey 与 extraHeaders 的值。 */
export function registerModelSecrets(model: {
  apiKey?: string;
  extraHeaders?: Record<string, string>;
}): void {
  registerSecret(model.apiKey);
  for (const v of Object.values(model.extraHeaders ?? {})) {
    registerSecret(v);
    // "Bearer xxx" 之类的头值：只登记令牌部分也要命中
    const token = /^\s*\S+\s+(\S+)\s*$/.exec(v)?.[1];
    if (token) registerSecret(token);
  }
}

/** 精确替换已登记的明文。 */
export function redactKnownSecrets(text: string): string {
  if (ordered.length === 0 || text.length < MIN_SECRET_LENGTH) return text;
  let out = text;
  for (const s of ordered) {
    if (out.includes(s)) out = out.split(s).join(REDACTED);
  }
  return out;
}

const SECRET_PATTERNS: [RegExp, string][] = [
  // OpenAI / Anthropic / DeepSeek / Moonshot / OpenRouter 等 sk- 前缀
  [/\bsk-[A-Za-z0-9_-]{8,}/g, REDACTED],
  // Google API Key
  [/\bAIza[0-9A-Za-z_-]{20,}/g, REDACTED],
  // xAI、Groq、GitHub、Hugging Face、Slack
  [/\b(?:xai|gsk|ghp|gho|ghu|ghs|github_pat|hf|xox[abprs])[-_][A-Za-z0-9_-]{16,}/g, REDACTED],
  // AWS Access Key ID
  [/\bAKIA[0-9A-Z]{16}\b/g, REDACTED],
  // JWT（OAuth 访问令牌常见形态）
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, REDACTED],
  // 授权头：Bearer / Basic
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${REDACTED}`],
  // key=value / "api_key": "value" 形态（api-key、x-api-key、access_token、secret、password 等）
  [
    /((?:api[-_]?key|x-api-key|access[-_]?token|refresh[-_]?token|secret|password|token)["']?\s*[:=]\s*["']?)[^\s"'&,;}]{8,}/gi,
    `$1${REDACTED}`,
  ],
];

/** 错误文本脱敏：精确值 + 常见密钥格式。 */
export function redactSecrets(text: string): string {
  let out = redactKnownSecrets(text);
  for (const [re, rep] of SECRET_PATTERNS) out = out.replace(re, rep);
  return out;
}

/** 测试用：清空登记表。 */
export function clearRegisteredSecrets(): void {
  secrets.clear();
  ordered = [];
}
