/**
 * 模型能力描述。
 *
 * 各家模型的差异全部吸收在适配层：Provider 暴露这份描述，其余模块
 * （Runtime / Context）只按描述行事，永远不写 `if (provider === ...)`。
 * 一旦出现这种分支，就说明适配层漏了东西。
 */
export interface ProviderCapabilities {
  /** 上下文窗口大小（token 数）。超限时由 Context 层负责压缩或降级。 */
  readonly maxContext: number;
  /** 是否支持并行工具调用；不支持时 loop 串行下发工具。 */
  readonly parallelToolCalls: boolean;
  /** 是否支持 prompt 缓存断点。 */
  readonly cacheBreakpoints: boolean;
  /** 是否支持图片输入。 */
  readonly images: boolean;
  /**
   * 推理模式：
   * - `none`：模型无推理过程；
   * - `native`：推理走独立的 reasoning 通道（本层透出为 thinking_delta）；
   * - `tagged`：推理以 `<think>...</think>` 标签混在正文里，本层负责剥离。
   */
  readonly thinking: 'none' | 'native' | 'tagged';
  /** 工具参数 JSON 是否严格；宽松者需要容错解析。 */
  readonly strictJsonArgs: boolean;
}
