# @modou/gui

modou 桌面 GUI —— Electron + React，**Claude Desktop 式布局**。core 的第二个前端：与 TUI 完全同构地消费事件流（Event↑ / Command↓），core 零改动。

## 为什么有它

- TUI（Ink）是终端场景的界面；GUI 面向桌面场景——历史会话侧栏、流式 markdown、工具卡片/diff、审批弹窗、设置面板，把「授权即操作」做得更直观；
- 架构上两者是 core 的**平级消费者**（002 2.1）：协议是唯一契约，界面可替换；
- 主进程桥（`electron/bridge.ts`）是 `runTui` 编排逻辑的 Electron 移植——同一套 provider / session / budget / compaction / slash 装配，core 一个字节没改。

## 结构

```
packages/gui/
  electron/            主进程（纯 Node，可单测）
    main.ts            Electron 入口：窗口 + IPC 接线
    preload.ts         contextBridge 暴露 window.modou
    bridge.ts          core 编排桥（runTui 的 Electron 移植）
    slash.ts          斜杠命令分发（纯函数）
    approval.ts        审批裁决桥
    compact.ts         /compact 手动压缩
    startup.ts         配置装配
    status.ts          token 累计 / 权限模式推导
    ipc.ts             IPC 通道常量 + 共享类型
  src/                 渲染进程（React）
    App.tsx            Claude Desktop 式布局
    components/        侧栏 / 对话流 / 工具卡片 / 审批 / 设置 / 选择器
    lib/               状态规约 / 工具规约 / markdown / 格式化
  tests/               bridge 集成 + 规约单测
```

## 开发 / 运行

```bash
# 安装（首次；会下载 Electron 二进制）
bun install

# 构建主进程 + 渲染进程
bun run --cwd packages/gui build

# 生产模式启动 GUI
bun run --cwd packages/gui start

# 开发模式（Vite HMR + Electron）
bun run --cwd packages/gui dev

# 测试 / 类型检查
bun run --cwd packages/gui test
bun run --cwd packages/gui typecheck
```

根目录便捷命令：`bun run gui`（构建+启动）。

## 与 TUI 的分工

|          | TUI（Ink）             | GUI（Electron）        |
| -------- | ---------------------- | ---------------------- |
| 场景     | 终端内使用、CI/无头    | 桌面窗口               |
| 会话侧栏 | /resume 选择器（模态） | 常驻左侧栏             |
| 工具展示 | 折叠单行 + Ctrl+O 展开 | 可展开卡片 + diff 高亮 |
| 审批     | 键盘弹窗               | 鼠标/键盘弹窗          |
| 设置     | settings.json 文件     | 设置面板（模型切换等） |

两者共用同一套协议与 core 状态；会话文件互通（GUI 里恢复的会话，TUI 里 `/resume` 也能看到）。

## 说明

- 主进程 bundle（`esbuild`）把 `@modou/core` 等依赖打进去，`electron` 与 `@vscode/ripgrep` 外部化（二进制路径按 node_modules 解析）；
- 跨平台安装：Electron 二进制按平台下载，换机器/换系统后重跑 `bun install` 即可；
- 安全边界：contextIsolation + 无 nodeIntegration，渲染进程只能经 `window.modou` 与主进程通信。

## 跨平台排障（node_modules 迁移/共享时）

Electron 是**单包单二进制**：`node_modules/electron/dist/` 里只能有一个平台的二进制，而它的安装脚本只在包不存在时重跑。如果 node_modules 在异构平台间共享（例如开发 VM 安装后同步回 macOS），`electron .` 会直接 spawn 报错：

```
Error: spawn Unknown system error -8
```

修复（本机重下当前平台的二进制）：

```bash
rm -rf node_modules/electron && bun install
```

`bun run start` / `bun run dev` 前会自动跑 `scripts/check-electron.mjs` 校验二进制平台（读文件头魔数，Mach-O vs ELF），不符时给出上面的提示而不是晦涩的 spawn 报错。
