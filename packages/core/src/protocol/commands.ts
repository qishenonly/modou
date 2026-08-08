/**
 * 反向通道 Command（design 002 3.3 表）：前端 → core 的唯一输入。
 *
 * 前端能做的事很少，这是有意的。`interrupt` 与 `steer` 是两个独立命令：
 * 打断后什么都不说（停在可继续的稳定点）与打断后立刻改口（新输入接进同一轮）
 * 在状态机里是两条不同路径（002 3.3 注释）。
 */

import type { ApprovalDecision } from './events';

/** 附件引用（submit 携带）。0.1.0 不支持附件，字段保留用于未来。 */
export interface AttachmentRef {
  readonly uri: string;
}

export type Command =
  | {
      readonly type: 'submit';
      /** 提交的用户输入文本 */
      readonly text: string;
      /** 附件引用（0.1.0 未支持，保留字段） */
      readonly attachments?: readonly AttachmentRef[];
    }
  | {
      readonly type: 'approve';
      /** 对 `approval_request` 的请求 ID */
      readonly requestId: string;
      /** 本次允许 / 始终允许此前缀 / 拒绝 */
      readonly decision: ApprovalDecision;
    }
  | { readonly type: 'interrupt' }
  | {
      readonly type: 'steer';
      /** 打断并注入的新指令 */
      readonly text: string;
    }
  | {
      readonly type: 'slash';
      /** 斜杠命令名（`/model`、`/compact`、`/resume`…） */
      readonly name: string;
      readonly args?: string;
    }
  | {
      readonly type: 'plan_approve';
      /** 批准当前计划：切换回执行模式并按计划开始执行。 */
    }
  | {
      readonly type: 'plan_reject';
      /** 拒绝当前计划：切换回执行模式，零文件改动（只读白名单保证）。 */
    }
  | {
      readonly type: 'plan_modify';
      /** 修改当前计划：关闭计划面板，保留计划模式继续迭代（用户输入修改意见）。 */
    };
