/**
 * 主进程 + preload 打包（esbuild）。
 *
 * 关键取舍：
 * - **只打包第一方代码**：`@modou/*`（workspace，TypeScript 源码）必须打进
 *   bundle——Electron 主进程（Node）不能直接 require .ts；其余 node_modules
 *   依赖（ai / zod / @ai-sdk/* / @vercel/oidc / electron …）一律**外部化**，
 *   由 Node 用原生 ESM/CJS 互操作加载。原因：把带动态 `require` / `__dirname`
 *   的 CJS 依赖打进 ESM bundle，会在运行时炸（如 `@vercel/oidc` 的
 *   `require("path")` → "Dynamic require of path is not supported"）；
 * - 输出 ESM（.mjs）：Electron ≥28 原生支持 ESM 主进程 / 非沙箱 ESM preload，
 *   且 core 的 `import.meta.url`（fixtures）在 ESM 下天然可用；
 * - core 主入口 `export * from './eval'` 连带导出了 provider 契约测试模块
 *   （import 'bun:test'），用插件把 `bun:test` stub 成 no-op（bundle 在 Node
 *   下加载不炸）。
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

/** 外部化所有裸导入（node_modules 依赖），只 bundle 相对路径与 @modou/* 工作区包。 */
const externalNodeModules = {
  name: 'external-node-modules',
  setup(build) {
    build.onResolve({ filter: /^[^./]/ }, (args) => {
      if (args.path.startsWith('@modou/')) return null; // 工作区 TS 源码，打包
      return { path: args.path, external: true };
    });
  },
};

const shared = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  sourcemap: 'inline',
  logLevel: 'info',
  plugins: [stubBunTest, externalNodeModules],
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
