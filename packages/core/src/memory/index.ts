/**
 * 文件式长期记忆模块（0.17.0 T-173，ADR 0016：不上向量库）。
 *
 * - store.ts：记忆存储——`<projectRoot>/.modou/memory/<key>.md` 结构化笔记
 *   （键控 / 有界 / 时间戳 frontmatter）；跨会话加载（loadMemoryText 注入上下文）；
 * - 工具侧：tools/impl/memory.ts（memory_write / memory_read / memory_list）。
 *
 * 模块依赖约束（002 2.2）：memory 属于 Config 扩展点，只依赖 node 内建。
 */
export * from './store';
