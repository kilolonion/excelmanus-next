// 内部事件总线（03 §4.2）：SessionLog 提交后发布 rec，运行时发布瞬时 delta
// 与应用级 app.event。server 的同步通道订阅后推送客户端。

import type { DeltaKind, LogRecord } from "@excelmanus/protocol";

export type BusEvent =
  | { kind: "rec"; rec: LogRecord }
  | {
      kind: "delta";
      sessionId: string;
      agentId: string;
      stepId: string;
      part: number;
      deltaKind: DeltaKind;
      payload: unknown;
    }
  | { kind: "app"; data: { type: string } & Record<string, unknown> };

type Subscriber = (event: BusEvent) => void;

export class SyncBus {
  private readonly subs = new Set<Subscriber>();

  subscribe(cb: Subscriber): () => void {
    this.subs.add(cb);
    return () => {
      this.subs.delete(cb);
    };
  }

  publish(event: BusEvent): void {
    for (const cb of this.subs) {
      try {
        cb(event);
      } catch {
        // 订阅者异常不影响其他订阅者与发布方
      }
    }
  }
}
