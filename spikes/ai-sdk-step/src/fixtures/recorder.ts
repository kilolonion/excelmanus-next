// 录制 fetch：记录脱敏后的请求/响应作为回放夹具。
// 脱敏规则：Authorization 头与任何 sk- 开头的串 → <redacted>；API Key 值全文替换。

export interface RecordedExchange {
  url: string;
  method: string;
  requestHeaders: Record<string, string>;
  requestBody: string;
  status: number;
  responseHeaders: Record<string, string>;
  /** SSE 原文截取（前 12000 字符，脱敏）。 */
  responseBody: string;
}

export class Recorder {
  exchanges: RecordedExchange[] = [];
  calls = 0;
  private readonly secrets: string[];
  private pending: Promise<void>[] = [];

  constructor(secrets: string[]) {
    this.secrets = secrets;
  }

  sanitize(s: string): string {
    let out = s.replace(/sk-[A-Za-z0-9._-]{4,}/g, "<redacted>");
    for (const sec of this.secrets) {
      if (sec.length >= 8) out = out.split(sec).join("<redacted>");
    }
    return out.replace(/Bearer\s+\S+/gi, "Bearer <redacted>");
  }

  sanitizeHeaders(h: Headers): Record<string, string> {
    const out: Record<string, string> = {};
    h.forEach((v, k) => {
      out[k] = /authorization|api[-_]?key|token/i.test(k) ? "<redacted>" : this.sanitize(v);
    });
    return out;
  }

  fetch: typeof globalThis.fetch = async (input, init) => {
    this.calls += 1;
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const reqHeaders = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : {}),
    );
    const body = typeof init?.body === "string" ? init.body : "";
    const res = await globalThis.fetch(input, init);
    const resHeaders: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      resHeaders[k] = this.sanitize(v);
    });
    const exchange: RecordedExchange = {
      url: this.sanitize(url),
      method: init?.method ?? "POST",
      requestHeaders: this.sanitizeHeaders(reqHeaders),
      requestBody: this.sanitize(body).slice(0, 20_000),
      status: res.status,
      responseHeaders: resHeaders,
      responseBody: "",
    };
    this.exchanges.push(exchange);
    // 响应体在后台读取副本，不阻塞 SDK 消费原始流（否则首字节延迟与中断都会失真）
    const clone = res.clone();
    this.pending.push(
      clone.text().then(
        (t) => {
          exchange.responseBody = this.sanitize(t.slice(0, 12_000));
        },
        () => {
          exchange.responseBody = "<aborted-or-unreadable>";
        },
      ),
    );
    return res;
  };

  /** 等待所有后台响应体读取完成（落盘前调用）。 */
  async settle(): Promise<void> {
    await Promise.allSettled(this.pending);
  }
}
