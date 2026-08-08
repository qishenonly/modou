/**
 * electron 二进制平台自检（跨平台安装防护）。
 *
 * 背景：node_modules 若在异构平台间共享/迁移（如开发 VM 安装后同步回 Mac），
 * electron 的 dist/ 里可能残留错误平台的二进制——它的安装脚本只在包不存在的
 * 时候重跑，bun install 不会察觉 dist 已被占。此时 `electron .` 会
 * spawn 报错（Linux ELF 在 macOS 上 spawn → system error -8）。
 *
 * 检查方式：读 electron 二进制的文件头魔数——Mach-O（macOS）与 ELF（Linux）
 * 的魔数不同，可在任何平台做确定性判定。发现平台不符时以清晰提示退出，
 * 并给出修复命令，而不是让用户面对晦涩的 spawn 报错。
 *
 * 用法：`node scripts/check-electron.mjs`（exit 0 = 平台正确）。
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = fileURLToPath(new URL('.', import.meta.url));
// scripts/ → gui → packages → 仓库根
const electronRoot = join(
  scriptDir,
  '..',
  '..',
  '..',
  'node_modules',
  'electron',
);

/** 读 electron 包里的平台二进制相对路径（install.js 写入 path.txt）。 */
async function binaryPath() {
  const pathFile = join(electronRoot, 'path.txt');
  const rel = (await readFile(pathFile, 'utf8')).trim();
  return join(electronRoot, 'dist', rel);
}

/** 取文件头 4 字节判定魔数：Mach-O（FEEDFACF / CEFAEDFE / FEEDFACE）或 ELF（7F ELF）。 */
function magicOf(head) {
  if (
    (head[0] === 0xfe &&
      head[1] === 0xed &&
      head[2] === 0xfa &&
      head[3] === 0xcf) ||
    (head[0] === 0xce &&
      head[1] === 0xfa &&
      head[2] === 0xed &&
      head[3] === 0xfe) ||
    (head[0] === 0xfe &&
      head[1] === 0xed &&
      head[2] === 0xfa &&
      head[3] === 0xce)
  ) {
    return 'macho';
  }
  if (
    head[0] === 0x7f &&
    head[1] === 0x45 &&
    head[2] === 0x4c &&
    head[3] === 0x46
  ) {
    return 'elf';
  }
  return 'unknown';
}

const FIX_HINT = '请在本机重跑：rm -rf node_modules/electron && bun install';

try {
  const binary = await binaryPath();
  const head = new Uint8Array(
    await readFile(binary).then((b) => b.subarray(0, 4)),
  );
  const magic = magicOf(head);

  // 只对「当前平台明确不支持」判定：macOS 上跑 ELF、Linux 上跑 Mach-O
  const wrongPlatform =
    (process.platform === 'darwin' && magic === 'elf') ||
    (process.platform === 'linux' && magic === 'macho');

  if (wrongPlatform) {
    console.error(
      `[modou-gui] electron 二进制平台不符（当前 ${process.platform}，二进制是 ${magic === 'elf' ? 'Linux(ELF)' : 'macOS(Mach-O)'} 版）。${FIX_HINT}`,
    );
    process.exit(1);
  }
  console.log('[modou-gui] electron 二进制平台检查通过');
} catch (caught) {
  // 读不到（未安装 / 未下载二进制）：交给 electron 自身报错，这里不拦截
  console.warn(
    `[modou-gui] 无法检查 electron 二进制（${caught instanceof Error ? caught.message : String(caught)}），跳过`,
  );
}
