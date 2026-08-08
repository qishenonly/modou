/**
 * 主进程 + preload 打包（esbuild）。
 *
 * 关键取舍：
 * - `@modou/core` 是 TypeScript 源码（workspace 软链），必须**打进 bundle**——
 *   Electron 主进程（Node）不能直接 require .ts，esbuild 负责把它编译成 ESM；
 * - 输出 ESM（.mjs）：Electron ≥28 原生支持 ESM 主进程 / 非沙箱 ESM preload，
 *   且 core 的 `import.meta.url`（fixtures）在 ESM 下天然可用；
 * - `electron` 外部化（运行时由 Electron 提供）；`@vscode/ripgrep` 外部化——
 *   其 `rgPath` 在运行时按 `__dirname` 计算到 node_modules 里的二进制，
 *   打进 bundle 会让路径指向 dist/，rg 找不到；
 * - core 主入口 `export * from './eval'` 连带导出了 provider 契约测试模块
 *   （import 'bun:test'），用插件把 `bun:test` stub 成 no-op（bundle 在 Node
 *   下加载不炸）；
 * - 其余依赖（ai / zod / @ai-sdk/* / react 等）全部打进 bundle。
 */
import { build } from 'esbuild';

/** 把 `bun:test` 的导入 stub 成 no-op（core 的契约测试模块被 index 连带导出）。 */
const stubBunTest = {
  name: 'stub-bun-test',
  setup(build) {
    build.onResolve({ filter: /^bun:test$/ }, () => ({
      path: 'bun:test',
      namespace: 'stub-bun-test',
    }));
    build.onLoad({ filter: /.*/, namespace: 'stub-bun-test' }, () => ({
      contents: [
        'export const describe = () => {};',
        'export const it = () => {};',
        'export const test = () => {};',
        'export const expect = () => {};',
        'export const beforeAll = () => {};',
        'export const afterAll = () => {};',
        'export const beforeEach = () => {};',
        'export const afterEach = () => {};',
      ].join('\n'),
      loader: 'js',
    }));
  },
};

const shared = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  external: ['electron', '@vscode/ripgrep'],
  sourcemap: 'inline',
  logLevel: 'info',
  plugins: [stubBunTest],
};

await build({
  ...shared,
  entryPoints: ['electron/main.ts'],
  outfile: 'dist/electron/main.mjs',
});

await build({
  ...shared,
  entryPoints: ['electron/preload.ts'],
  outfile: 'dist/electron/preload.mjs',
});
