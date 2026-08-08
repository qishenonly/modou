/**
 * Electron 主进程入口：窗口管理 + 把 GuiBridge 接到 IPC。
 *
 * 分层：bridge.ts 不 import 'electron'（可单测），本文件只做接线——
 * - `ipcMain.handle` 把渲染进程的「拉取型」invoke 接到桥的查询方法；
 * - `ipcMain.on(COMMAND)` 把 Command 交给 bridge.sendCommand；
 * - 桥的 emitEvent → webContents.send(EVENT)；emitReady → send(READY)。
 *
 * 窗口：Claude Desktop 式布局（宽窗口、左侧会话侧栏），production 加载
 * dist/renderer（vite build 产物，base './'，file:// 可加载），开发模式
 * 经 MODOU_GUI_DEV=1 加载 MODOU_GUI_DEV_URL（scripts/dev.mjs 注入）。
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, ipcMain, shell } from 'electron';
import { GuiBridge } from './bridge';
import { IPC, type ReadyPayload } from './ipc';
import type { Command, Envelope } from '@modou/core';

const isDev = process.env.MODOU_GUI_DEV === '1';
const devUrl = process.env.MODOU_GUI_DEV_URL ?? 'http://localhost:5173';
// ESM 下无 __dirname：从 import.meta.url 换算（bundle 输出 .mjs，原生 ESM）
const __dirname = dirname(fileURLToPath(import.meta.url));

let mainWindow: BrowserWindow | null = null;
let bridge: GuiBridge | null = null;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 880,
    minHeight: 600,
    title: 'modou — 墨斗',
    backgroundColor: '#faf9f7',
    show: false,
    webPreferences: {
      preload: join(__dirname, 'preload.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // preload 用 contextBridge，需要 node 能力
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow?.show());

  // 外链（帮助 / 文档）一律交给系统浏览器，不劫持到应用内窗口
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  if (isDev) {
    void mainWindow.loadURL(devUrl);
  } else {
    void mainWindow.loadFile(join(__dirname, '..', 'renderer', 'index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function wireBridge(): void {
  bridge = new GuiBridge(
    {},
    {
      emitEvent: (envelope: Envelope) => {
        if (mainWindow !== null && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send(IPC.EVENT, envelope);
        }
      },
      emitReady: (payload: ReadyPayload) => {
        if (mainWindow !== null && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send(IPC.READY, payload);
        }
      },
    },
  );

  // 启动：把指令告警等启动期 notice 入队，然后推 ReadyPayload
  const ready = bridge.start();
  if (mainWindow !== null && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(IPC.READY, ready);
  }

  // Command 通道（002 3.3 反向通道）
  ipcMain.on(IPC.COMMAND, (_event, command: Command) => {
    bridge?.sendCommand(command);
  });

  // 「拉取型」控制面
  ipcMain.handle(IPC.LIST_SESSIONS, () => bridge?.listSessions() ?? []);
  ipcMain.handle(IPC.GET_THREAD, () => bridge?.getThread() ?? []);
  ipcMain.handle(IPC.LIST_MODELS, () => bridge?.listModels() ?? []);
  ipcMain.handle(IPC.GET_CONTEXT, () => bridge?.getContext() ?? null);
  ipcMain.handle(IPC.GET_CONFIG, () => bridge?.getConfig() ?? null);
  ipcMain.handle(
    IPC.DELETE_SESSION,
    (_event, sessionId: string) => bridge?.deleteSession(sessionId) ?? false,
  );
  ipcMain.handle(IPC.QUIT, () => {
    bridge?.dispose();
    app.quit();
  });
}

app.whenReady().then(() => {
  createWindow();
  wireBridge();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  bridge?.dispose();
  if (process.platform !== 'darwin') app.quit();
});
