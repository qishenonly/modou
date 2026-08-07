/**
 * 危险命令黑名单（T-033）。
 *
 * 命中 = 即使该命令此前已被「始终允许此前缀」（allow_always）记住，也**强制逐次
 * 确认**——防「信任一次就永远放行危险命令」。黑名单只做「强制确认」，不做拒绝：
 * 用户仍可放行（前端弹窗 / headless autoApprove 会逐次走审批流程）。
 *
 * 定位（002 6.3）：shell 命令的前缀匹配可以被绕过（`bash -c`、`eval`、`;` 串联、
 * 别名等），所以本黑名单是「防手滑、防模型莽撞」的**深度防御一层，不是安全边界**。
 * 真正的隔离依赖 1.0.0 的 OS 级沙箱（Seatbelt / Landlock / 容器）。0.3.0 只做内置
 * 固定清单的强制确认，不做可配置扩展（可配置正交权限模型 / allow-deny 规则表留
 * 0.4.0）。
 */

/**
 * 归一化命令：折叠任意空白为单个空格、去掉首尾空白、剥离首部 `sudo `。
 * `sudo rm -rf /` 与 `rm -rf /` 同样危险，剥离前缀使两者都命中黑名单。
 *
 * T-052 规则表（rules.ts）复用此函数做命令候选串归一：用户写 `--rule deny:rm -rf`，
 * 模型跑 `sudo rm -rf /x` 或 `rm  -rf /x` 都同样命中。规则表不做可配置持久化，
 * 但命令归一逻辑只此一份，不重复实现。
 */
export function normalizeCommand(command: string): string {
  return command
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/^sudo\s+/, '');
}

/** 拆 token（按空白）。 */
function tokenize(command: string): string[] {
  return command.split(/\s+/);
}

/**
 * `rm` 是否带「递归 + 强制」两个 flag。
 * 覆盖 `-rf` / `-fr` / `-r -f` / `-Rf` / `--recursive --force` 等短 flag 组合写法。
 */
function rmRecursiveForce(tokens: string[]): boolean {
  if (tokens[0] !== 'rm') return false;
  let recursive = false;
  let force = false;
  for (let i = 1; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === '--') break; // `--` 之后是路径，不再是 flag
    if (token.startsWith('--')) {
      if (token === '--recursive') recursive = true;
      if (token === '--force') force = true;
    } else if (token.startsWith('-') && token.length > 1) {
      for (const flag of token.slice(1)) {
        if (flag === 'r' || flag === 'R') recursive = true;
        if (flag === 'f') force = true;
      }
    }
  }
  return recursive && force;
}

/** `git push` 是否带强制推送 flag（`-f` / `--force`）。 */
function gitPushForce(tokens: string[]): boolean {
  if (tokens[0] !== 'git' || tokens[1] !== 'push') return false;
  return tokens.slice(2).some((token) => token === '-f' || token === '--force');
}

/** `chmod` 是否带递归 flag（`-R` / `--recursive`，含组合短 flag 如 `-Rf`）。 */
function chmodRecursive(tokens: string[]): boolean {
  if (tokens[0] !== 'chmod') return false;
  return tokens
    .slice(1)
    .some(
      (token) =>
        token === '-R' ||
        token === '--recursive' ||
        /^-[a-zA-Z]*R[a-zA-Z]*$/.test(token),
    );
}

/** 从远端拉取脚本直接管道给 shell 执行（`curl … | sh` / `wget … | bash`）。 */
const PIPE_TO_SHELL = /^(?:curl|wget)\s+.*\|\s*(?:sudo\s+)?(?:sh|bash)(?:\s|$)/;

/** fork bomb（bash 递归函数）的两种典型写法判定。 */
function isForkBomb(command: string): boolean {
  // `:(){ :|:& };:` 及其空白变体（管道给自身并后台运行）
  if (command.includes(':|:&')) return true;
  // 函数定义开头：`:(){` / `: ( ) {`（空白可变）
  return /:\s*\(\s*\)\s*\{/.test(command);
}

/**
 * 判定一条命令是否命中危险黑名单。
 *
 * 命中项（0.3.0 内置清单，不可配置）：
 * - `rm` 带递归 + 强制（`rm -rf` 系）；
 * - `git push` 带 `-f` / `--force`（强制推送）；
 * - `dd`、`mkfs`（磁盘级写入）；
 * - `chmod` 带递归（`-R` / `--recursive`）；
 * - 系统电源命令：`shutdown` / `halt` / `poweroff` / `reboot`；
 * - `curl` / `wget` 拉取脚本管道给 `sh` / `bash`；
 * - fork bomb（`:(){ :|:& };:` 系）。
 */
export function isDangerousCommand(command: string): boolean {
  const normalized = normalizeCommand(command);
  if (normalized.length === 0) return false;
  const tokens = tokenize(normalized);
  const first = tokens[0];

  // 磁盘级 / 系统级破坏
  if (first === 'dd') return true;
  if (first === 'mkfs' || first.startsWith('mkfs.')) return true;
  if (['shutdown', 'halt', 'poweroff', 'reboot'].includes(first)) return true;

  // 递归强制删除 / 递归改权限
  if (rmRecursiveForce(tokens)) return true;
  if (chmodRecursive(tokens)) return true;

  // 强制推送远端
  if (gitPushForce(tokens)) return true;

  // 管道给 shell 执行远端脚本 / fork bomb
  if (PIPE_TO_SHELL.test(normalized)) return true;
  if (isForkBomb(normalized)) return true;

  return false;
}
