/**
 * react-devtools-core 占位模块（T-092 打包用）。
 *
 * ink 的 devtools.js 在 `DEV === 'true'` 时动态 `import('react-devtools-core')`
 * 连接 React DevTools。bun build 会把该动态导入提升为顶层静态导入——若以
 * `--external react-devtools-core` 打包，产物在加载期就报「Cannot find
 * package」。这里提供一个 no-op 占位，经 `--alias react-devtools-core=<本文件>`
 * 在打包时替换：正常使用（DEV 未设置）永不执行；即便设置 DEV=true 也只是
 * no-op，不影响功能。
 */
export function connectToDevTools(): void {
  // no-op：打包后的单文件形态不支持 React DevTools 调试
}

export default { connectToDevTools };
