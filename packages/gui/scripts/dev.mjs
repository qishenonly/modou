/**
 * GUI 开发模式：并行启动 Vite dev server + Electron（加载 dev URL）。
 *
 * Electron 主进程通过 `MODOU_GUI_DEV=1` 环境变量识别开发模式，
 * 从 `MODOU_GUI_DEV_URL`（缺省 http://localhost:5173）加载渲染进程。
 */
import { spawn } from 'node:child_process';

const VITE_URL = process.env.MODOU_GUI_DEV_URL ?? 'http://localhost:5173';

const vite = spawn('bun', ['x', 'vite'], {
  stdio: 'inherit',
  env: { ...process.env },
});

let electronStarted = false;
const startElectron = () => {
  if (electronStarted) return;
  electronStarted = true;
  const electron = spawn('bun', ['x', 'electron', '.'], {
    stdio: 'inherit',
    env: {
      ...process.env,
      MODOU_GUI_DEV: '1',
      MODOU_GUI_DEV_URL: VITE_URL,
    },
  });
  electron.on('exit', () => {
    vite.kill();
    process.exit(0);
  });
};

vite.stdout?.on('data', (chunk) => {
  const text = chunk.toString();
  process.stdout.write(chunk);
  if (!electronStarted && text.includes('Local:')) startElectron();
});

vite.on('exit', () => process.exit(0));
