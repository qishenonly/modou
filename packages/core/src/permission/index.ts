/**
 * 权限子系统（design 002 六、权限子系统）。
 * T-033：危险命令黑名单 + ApprovalGate 最小审批闸门；
 * T-050：正交权限内核（policy.ts——沙箱范围 × 审批策略矩阵裁决，ADR 0007），
 *        ApprovalGate 接入 decidePermission（allow 直通 / deny 拒绝 / ask 才问）。
 */
export * from './danger';
export * from './approval';
export * from './policy';
