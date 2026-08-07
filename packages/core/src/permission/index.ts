/**
 * 权限子系统（design 002 六、权限子系统）。
 * 0.3.0 子集：最小审批闸门（T-033）——危险命令黑名单 + ApprovalGate。
 * 正交权限模型（untrusted / on-request / never）与 allow/deny 规则表留 0.4.0。
 */
export * from './danger';
export * from './approval';
