// ModelGateway 窄接口（03 §5.2）：kernel 只声明，models 包实现。
// 运行时与日志只见中立格式。

import type {
  ContextItem,
  JsonObject,
  ResolvedModel,
  StepEvent,
  ToolSpec,
} from "@excelmanus/protocol";

export interface StepRequest {
  model: ResolvedModel;
  /** 会话冻结的系统提示词。 */
  system?: string;
  history: ContextItem[];
  /** 名称 + 说明 + JSON Schema，不含执行函数。 */
  tools?: ToolSpec[];
  /** 透传给提供商的选项。 */
  providerOptions?: JsonObject;
  signal: AbortSignal;
}

export interface ModelGateway {
  step(req: StepRequest): AsyncIterable<StepEvent>;
}
