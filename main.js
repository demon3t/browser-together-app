const { app, BrowserWindow, WebContentsView, ipcMain, clipboard, shell } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('node:path');

// Сервер-ретранслятор. Адрес зашит в приложение (а не берётся из ссылки), чтобы чужая ссылка
// не могла незаметно отправить трансляцию на посторонний сервер.
const SERVER_URL = process.env.BT_SERVER || 'https://92-51-44-211.sslip.io';
const PROTOCOL = 'browsertogether';
const START_URL = process.env.BT_START_URL || 'https://www.youtube.com';
const TOOLBAR_HEIGHT = 52;

let win = null;
let site = null;
let fullscreen = false;
let uiReady = false; // панель загрузилась и может принимать сообщения
let pendingJoin = null;
// Обновление обязательное: пока не проверили версию (или нужна новая), к комнате не подключаемся.
// 'checking' — проверяем, 'required' — нужна новая версия, 'ok' — можно работать.
let updateState = 'checking';
let requiredVersion = null;

// Версия для разработки ("npm start") хранит данные отдельно от установленной. Иначе у них общий
// замок единственного экземпляра, и запуск из папки проекта передал бы ссылку в окно установленного
// приложения (и прервал бы идущую в нём трансляцию).
if (!app.isPackaged) app.setPath('userData', path.join(app.getPath('appData'), 'browser-together-app-dev'));

// Регистрируем только установленную версию. При запуске через "npm start" регистрация
// записала бы в систему electron.exe с аргументами разработчика и сломала бы ссылки.
if (app.isPackaged) app.setAsDefaultProtocolClient(PROTOCOL);

// ---------- Ссылки browsertogether://host?code=XXXXXX ----------
function joinFromArgv(argv) {
  const link = argv.find((a) => a.startsWith(`${PROTOCOL}://`));
  if (!link) return;
  let code;
  try {
    code = new URL(link).searchParams.get('code');
  } catch {
    return;
  }
  code = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
  if (!code) return;
  pendingJoin = code;
  flushJoin();
}

function flushJoin() {
  if (!pendingJoin || updateState !== 'ok' || !uiReady) return;
  win.webContents.send('join', pendingJoin);
  pendingJoin = null;
}

// Второй запуск (клик по ссылке, когда приложение уже открыто) передаём в первое окно
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (event, argv) => {
    joinFromArgv(argv);
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
  joinFromArgv(process.argv);
  app.whenReady().then(() => {
    createWindow();
    checkForUpdate();
  });
  app.on('window-all-closed', () => app.quit());
}

// ---------- Обязательное обновление ----------
// Файлы обновлений лежат на сервере (папка /app/, см. "publish" в package.json).
// Скачиваем только после нажатия кнопки Update, затем ставим и перезапускаем приложение.
function checkForUpdate() {
  const feed = process.env.BT_UPDATE_URL; // для проверки обновлений в разработке
  if (!app.isPackaged && !feed) {
    setUpdateState('ok');
    return;
  }
  if (feed) {
    autoUpdater.forceDevUpdateConfig = true;
    autoUpdater.setFeedURL({ provider: 'generic', url: feed });
  }
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;

  autoUpdater.on('update-available', (info) => {
    requiredVersion = info.version;
    setUpdateState('required');
  });
  autoUpdater.on('update-not-available', () => setUpdateState('ok'));
  autoUpdater.on('download-progress', (progress) => win?.webContents.send('update-progress', progress.percent));
  autoUpdater.on('update-downloaded', () => {
    win?.webContents.send('update-installing');
    // Тихая установка и перезапуск новой версии
    setTimeout(() => autoUpdater.quitAndInstall(true, true), 800);
  });
  autoUpdater.on('error', () => {
    // Не смогли проверить (нет сети, сервер недоступен) — не блокируем работу
    if (updateState === 'checking') setUpdateState('ok');
    else win?.webContents.send('update-error');
  });
  autoUpdater.checkForUpdates().catch(() => {});
}

function setUpdateState(state) {
  updateState = state;
  if (state === 'required') {
    site?.setVisible(false);
    sendUpdateRequired();
  }
  flushJoin();
}

function sendUpdateRequired() {
  if (updateState === 'required' && uiReady) {
    win.webContents.send('update-required', requiredVersion);
  }
}

ipcMain.on('update-start', () => {
  if (updateState === 'required') autoUpdater.downloadUpdate().catch(() => win?.webContents.send('update-error'));
});

// Запасной путь: открыть установщик в обычном браузере
ipcMain.on('download-installer', () => shell.openExternal(`${SERVER_URL}/app/BrowserTogether-Setup.exe`));

// ---------- Окно ----------
// Сайты (например, вход в Google) не любят "Electron" в User-Agent — оставляем обычный Chrome
function chromeUserAgent(ua) {
  return ua.split(' ').filter((part) => !/^(Electron|browser-together-app|Browser ?Together)\//i.test(part)).join(' ');
}

function layout() {
  const [width, height] = win.getContentSize();
  site.setBounds(fullscreen
    ? { x: 0, y: 0, width, height }
    : { x: 0, y: TOOLBAR_HEIGHT, width, height: Math.max(0, height - TOOLBAR_HEIGHT) });
}

function sendPage() {
  const wc = site.webContents;
  win.webContents.send('page', {
    url: wc.getURL(),
    title: wc.getTitle(),
    canGoBack: wc.navigationHistory.canGoBack(),
    canGoForward: wc.navigationHistory.canGoForward(),
    loading: wc.isLoading(),
  });
}

function normalizeUrl(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  if (/^https?:\/\//i.test(s)) return s;
  if (/^[\w-]+(\.[\w-]+)+(:\d+)?(\/.*)?$/.test(s) || /^localhost(:\d+)?(\/.*)?$/.test(s)) return 'https://' + s;
  return 'https://www.google.com/search?q=' + encodeURIComponent(s);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 760,
    minHeight: 480,
    title: 'Browser Together',
    icon: path.join(__dirname, 'build', 'icon.png'),
    backgroundColor: '#0a0a0a',
    autoHideMenuBar: true,
    show: !process.env.BT_BACKGROUND, // для автотестов: окно не появляется и не отбирает фокус
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  win.removeMenu();
  win.loadFile(path.join(__dirname, 'ui', 'index.html'));

  // Вкладка, которую видят зрители. Отдельный постоянный профиль: входы на сайты сохраняются
  site = new WebContentsView({ webPreferences: { partition: 'persist:site' } });
  win.contentView.addChildView(site);
  const wc = site.webContents;
  wc.setUserAgent(chromeUserAgent(wc.getUserAgent()));
  wc.loadURL(START_URL);
  layout();
  win.on('resize', layout);
  if (updateState === 'required') site.setVisible(false);

  // Новые окна открываем в этой же вкладке: зрители видят только её
  wc.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) wc.loadURL(url);
    return { action: 'deny' };
  });
  for (const event of ['did-navigate', 'did-navigate-in-page', 'page-title-updated', 'did-start-loading', 'did-stop-loading']) {
    wc.on(event, sendPage);
  }

  // Полноэкранное видео на сайте растягиваем на всё окно
  wc.on('enter-html-full-screen', () => {
    fullscreen = true;
    win.setFullScreen(true);
    layout();
  });
  wc.on('leave-html-full-screen', () => {
    fullscreen = false;
    win.setFullScreen(false);
    layout();
  });

  // Панель запрашивает захват экрана — отдаём ей именно вкладку сайта, вместе со звуком
  win.webContents.session.setDisplayMediaRequestHandler((request, callback) => {
    callback({ video: wc.mainFrame, audio: wc.mainFrame });
  });

  win.webContents.on('did-finish-load', () => {
    uiReady = true;
    sendPage();
    sendUpdateRequired();
    flushJoin();
  });
}

ipcMain.handle('config', () => ({ server: SERVER_URL, version: app.getVersion() }));

ipcMain.on('copy', (event, text) => clipboard.writeText(String(text)));

ipcMain.on('navigate', (event, action, url) => {
  const wc = site?.webContents;
  if (!wc) return;
  if (action === 'goto') {
    const target = normalizeUrl(url);
    if (target) wc.loadURL(target);
  } else if (action === 'back') {
    wc.navigationHistory.goBack();
  } else if (action === 'forward') {
    wc.navigationHistory.goForward();
  } else if (action === 'reload') {
    if (wc.isLoading()) wc.stop();
    else wc.reload();
  }
  wc.focus();
});
