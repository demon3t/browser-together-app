const { app, BrowserWindow, WebContentsView, session, ipcMain } = require('electron');
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
let pendingJoin = null;

// ---------- Ссылки browsertogether://host?code=XXXXXX ----------
// Регистрируем только установленную версию. При запуске через "npm start" регистрация
// записала бы в систему electron.exe с аргументами разработчика и сломала бы ссылки.
if (app.isPackaged) app.setAsDefaultProtocolClient(PROTOCOL);

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
  if (win) win.webContents.send('join', code);
  else pendingJoin = code;
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
  app.whenReady().then(createWindow);
  app.on('window-all-closed', () => app.quit());
}

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
    icon: path.join(__dirname, 'build', 'icon.png'),    backgroundColor: '#1e1f22',
    autoHideMenuBar: true,
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
    sendPage();
    if (pendingJoin) {
      win.webContents.send('join', pendingJoin);
      pendingJoin = null;
    }
  });
}

ipcMain.handle('config', () => ({ server: SERVER_URL, version: app.getVersion() }));

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
    wc.reload();
  }
  wc.focus();
});
