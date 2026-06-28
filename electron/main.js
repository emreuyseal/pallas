const { app, BrowserWindow, shell, Tray, Menu, nativeImage } = require('electron');
const path   = require('path');
const os     = require('os');
const { spawn } = require('child_process');

let mainWindow = null;
let tray       = null;
let serverStarted = false;

// ── Start Ollama if not running ───────────────────────────────────────────────
function tryStartOllama() {
  const ollamaExe = path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Ollama', 'ollama.exe');
  try {
    const proc = spawn(ollamaExe, [], { detached: true, stdio: 'ignore' });
    proc.unref();
  } catch (_) {}
}

// ── Start Express server in-process ──────────────────────────────────────────
function startServer() {
  if (serverStarted) return;
  serverStarted = true;
  // Override data dir to use Electron's userData so data persists across updates
  process.env.PALLAS_DATA = path.join(app.getPath('userData'), 'data');
  require('../server.js');
}

// ── Wait until Express is accepting connections ───────────────────────────────
async function waitForServer(port = 3000, retries = 30) {
  for (let i = 0; i < retries; i++) {
    try {
      await fetch(`http://localhost:${port}/api/status`);
      return true;
    } catch (_) {
      await new Promise(r => setTimeout(r, 500));
    }
  }
  return false;
}

// ── Create main window ────────────────────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width:  1300,
    height: 820,
    minWidth:  900,
    minHeight: 620,
    backgroundColor: '#15161a',
    icon: path.join(__dirname, '..', 'public', 'logo.png'),
    title: 'Pallas',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadURL('http://localhost:3000');

  // Open external links in the system browser, not Electron
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

// ── System tray ───────────────────────────────────────────────────────────────
function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, '..', 'public', 'logo.png'))
    .resize({ width: 16, height: 16 });
  tray = new Tray(icon);
  tray.setToolTip('Pallas');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Pallas', click: () => { if (mainWindow) mainWindow.show(); else createWindow(); } },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]));
  tray.on('double-click', () => { if (mainWindow) mainWindow.show(); else createWindow(); });
}

// ── App lifecycle ─────────────────────────────────────────────────────────────
app.whenReady().then(async () => {
  tryStartOllama();
  startServer();
  createTray();
  const ready = await waitForServer();
  if (!ready) {
    console.error('Server failed to start');
    app.quit();
    return;
  }
  createWindow();
});

app.on('window-all-closed', () => {
  // Keep running in tray on Windows
  if (process.platform === 'darwin') app.quit();
});

app.on('activate', () => {
  if (!mainWindow) createWindow();
});
