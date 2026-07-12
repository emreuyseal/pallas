const { app, BrowserWindow, shell, Tray, Menu, nativeImage, dialog } = require('electron');
const path   = require('path');
const os     = require('os');
const { spawn } = require('child_process');

let mainWindow  = null;
let tray        = null;
let serverProc  = null;

function tryStartOllama() {
  const exe = path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Ollama', 'ollama.exe');
  try { spawn(exe, [], { detached: true, stdio: 'ignore' }).unref(); } catch (_) {}
}

function startServer() {
  const nodeCandidates = [
    'C:\\Program Files\\nodejs\\node.exe',
    'C:\\Program Files (x86)\\nodejs\\node.exe',
    path.join(os.homedir(), 'AppData', 'Roaming', 'nvm', 'current', 'node.exe'),
    'node', // fallback to PATH
  ];

  const serverPath = path.join(__dirname, 'server.js');
  const dataDir    = path.join(app.getPath('userData'), 'data');

  let node = 'node';
  const fs = require('fs');
  for (const c of nodeCandidates) {
    if (c === 'node') { node = 'node'; break; }
    if (fs.existsSync(c)) { node = c; break; }
  }

  serverProc = spawn(node, [serverPath], {
    cwd: __dirname,
    env: { ...process.env, PALLAS_DATA: dataDir, PORT: '3000' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  serverProc.stdout.on('data', d => console.log('[server]', d.toString().trim()));
  serverProc.stderr.on('data', d => console.error('[server-err]', d.toString().trim()));
  serverProc.on('error', err => console.error('[server spawn error]', err.message));
  serverProc.on('exit', code => console.log('[server exited]', code));
}

async function waitForServer(port = 3000, retries = 40) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(`http://localhost:${port}/api/status`);
      if (res.ok || res.status < 500) return true;
    } catch (_) {}
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width:  1300,
    height: 820,
    minWidth:  900,
    minHeight: 620,
    backgroundColor: '#15161a',
    icon: path.join(__dirname, 'public', 'logo.png'),
    title: 'Pallas',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadURL('http://localhost:3000');

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

function createTray() {
  try {
    const icon = nativeImage.createFromPath(path.join(__dirname, 'public', 'logo.png'))
      .resize({ width: 16, height: 16 });
    tray = new Tray(icon);
    tray.setToolTip('Pallas');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Open Pallas', click: () => mainWindow ? mainWindow.show() : createWindow() },
      { type: 'separator' },
      { label: 'Quit', click: () => app.quit() },
    ]));
    tray.on('double-click', () => mainWindow ? mainWindow.show() : createWindow());
  } catch (e) {
    console.error('Tray error:', e.message);
  }
}

app.whenReady().then(async () => {
  tryStartOllama();
  startServer();
  createTray();

  const ready = await waitForServer();
  if (!ready) {
    dialog.showErrorBox('Pallas', 'Server failed to start. Make sure Node.js is installed.');
    app.quit();
    return;
  }
  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {}
});

app.on('activate', () => {
  if (!mainWindow) createWindow();
});

app.on('before-quit', () => {
  if (serverProc) serverProc.kill();
});
