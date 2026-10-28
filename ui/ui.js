// Панель приложения: адресная строка + трансляция вкладки на сервер Browser Together.
const $ = (id) => document.getElementById(id);

const FPS = 30;
const MAX_BITRATE = 2_500_000;
const MIN_BITRATE = 600_000;
const MAX_WIDTH = 1280;
const MAX_HEIGHT = 720;
// Сколько данных может ждать отправки. Больше — значит интернет хоста не успевает,
// и копить очередь нельзя: каждый лишний мегабайт — это секунды задержки у зрителей.
const SEND_BUFFER_LIMIT = 256 * 1024;

let config = null;
let code = null;
let ws = null;
let stream = null;
let viewers = 0;
let reconnectTimer = null;
let currentPage = { url: '', title: '' };

// ---------- Навигация ----------
$('back').addEventListener('click', () => window.bt.navigate('back'));
$('forward').addEventListener('click', () => window.bt.navigate('forward'));
$('reload').addEventListener('click', () => window.bt.navigate('reload'));
$('url-form').addEventListener('submit', (e) => {
  e.preventDefault();
  window.bt.navigate('goto', $('url').value);
  $('url').blur();
});

window.bt.onPage((page) => {
  currentPage = { url: page.url, title: page.title };
  if (document.activeElement !== $('url')) $('url').value = page.url;
  $('back').disabled = !page.canGoBack;
  $('forward').disabled = !page.canGoForward;
  $('reload-icon').setAttribute('href', page.loading ? '#i-stop' : '#i-reload');
  $('reload').title = page.loading ? 'Stop' : 'Reload';
  $('progress').hidden = !page.loading;
  $('url-icon').setAttribute('href', page.url.startsWith('https:') ? '#i-lock' : '#i-globe');
  document.title = page.title ? `${page.title} — Browser Together` : 'Browser Together';
  send({ t: 'page', ...currentPage });
});

// ---------- Подключение по коду ----------
window.bt.onJoin((newCode) => connect(newCode));

$('code-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const value = $('code').value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (value) connect(value);
});

$('disconnect').addEventListener('click', () => disconnect());

// ---------- Код комнаты: скрыт, пока не нажали на глаз ----------
let codeVisible = false;

function renderCode() {
  $('live-code').textContent = codeVisible ? code || '' : '••••••';
  $('toggle-code-icon').setAttribute('href', codeVisible ? '#i-eye-off' : '#i-eye');
  $('toggle-code').title = codeVisible ? 'Hide code' : 'Show code';
}

$('toggle-code').addEventListener('click', () => {
  codeVisible = !codeVisible;
  renderCode();
});

let copyTimer = null;
$('copy-code').addEventListener('click', () => {
  if (!code) return;
  window.bt.copy(code);
  $('copy-code-icon').setAttribute('href', '#i-check');
  $('copy-code').title = 'Copied';
  clearTimeout(copyTimer);
  copyTimer = setTimeout(() => {
    $('copy-code-icon').setAttribute('href', '#i-copy');
    $('copy-code').title = 'Copy code';
  }, 1500);
});

// state: 'on' — в эфире, 'error' — связь потеряна, '' — подключение.
// Состояние видно по точке на кнопке Stop, текст — во всплывающей подсказке.
function showLive(text, state) {
  $('code-form').hidden = true;
  $('live').hidden = false;
  $('disconnect').className = `stop ${state || ''}`;
  $('disconnect').title = `${text} — click to stop streaming`;
  $('viewers').hidden = state !== 'on';
  renderCode();
}

// Сервер присылает код ошибки, текст показываем на английском
const ERRORS = {
  room_not_found: 'Room code not found or expired. Get a new one in the Discord activity.',
};

function showCodeForm(error) {
  $('live').hidden = true;
  $('code-form').hidden = false;
  $('code-error').hidden = !error;
  $('code-error').textContent = error || '';
}

function updateLiveText() {
  $('viewers-count').textContent = viewers;
  showLive('Streaming', 'on');
}

async function connect(newCode) {
  config ??= await window.bt.getConfig();
  disconnect(true);
  code = newCode;
  $('code').value = code;
  showLive('Connecting…', '');

  const url = config.server.replace(/^http/, 'ws') + `/?role=app&code=${encodeURIComponent(code)}`;
  const socket = new WebSocket(url);
  ws = socket;
  let rejected = false;

  socket.addEventListener('message', async (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.t === 'welcome') {
      viewers = msg.viewers;
      updateLiveText();
      send({ t: 'page', ...currentPage });
      await ensureCapture();
      updateEncoding();
    } else if (msg.t === 'error') {
      rejected = true;
      code = null;
      showCodeForm(ERRORS[msg.code] || 'Could not connect. Try again.');
    } else if (msg.t === 'viewers') {
      viewers = msg.count;
      if (ws === socket) updateLiveText();
      updateEncoding();
    } else if (msg.t === 'keyframe') {
      encoder?.requestKey();
    }
  });

  socket.addEventListener('close', () => {
    if (ws !== socket) return;
    stopEncoding();
    if (rejected || !code) return;
    // Связь оборвалась — переподключаемся с тем же кодом
    showLive('Reconnecting…', 'error');
    reconnectTimer = setTimeout(() => connect(code), 3000);
  });
}

function disconnect(silent) {
  clearTimeout(reconnectTimer);
  stopEncoding();
  const socket = ws;
  ws = null;
  socket?.close();
  if (!silent) {
    code = null;
    showCodeForm();
  }
}

function send(msg) {
  if (ws?.readyState === 1) ws.send(JSON.stringify(msg));
}

// ---------- Захват вкладки ----------
// Главный процесс отвечает на этот запрос вкладкой сайта (видео + звук), см. setDisplayMediaRequestHandler
async function ensureCapture() {
  if (stream?.active) return;
  stream = await navigator.mediaDevices.getDisplayMedia({
    video: { width: { max: MAX_WIDTH }, height: { max: MAX_HEIGHT }, frameRate: { max: FPS } },
    audio: true,
  });
}

// ---------- Кодирование и отправка ----------
// Пакет: [тип: 1 = ключевой кадр, 2 = обычный кадр, 3 = звук][время: float64, мкс][данные]
let encoder = null;

function updateEncoding() {
  if (viewers > 0 && ws?.readyState === 1 && stream) startEncoding();
  else stopEncoding();
}

// Пакет: [тип | 0x10][время кадра: float64, мкс][время отправки: float64, мс][данные]
// Тип: 1 = ключевой кадр, 2 = обычный кадр, 3 = звук. Флаг 0x10 говорит, что есть время отправки —
// по нему зрители оценивают задержку.
const HAS_SENT_AT = 0x10;
let skipUntilKey = false; // канал переполнился — ждём ключевой кадр, чтобы зрители сразу догнали эфир
let congested = false; // за последнюю секунду были пропуски из-за медленного интернета

function sendPacket(type, chunk) {
  if (ws?.readyState !== 1) return;
  const isVideo = type !== 3;
  if (ws.bufferedAmount > SEND_BUFFER_LIMIT) {
    congested = true;
    if (isVideo) {
      skipUntilKey = true;
      encoder?.requestKey();
    }
    return;
  }
  if (isVideo && skipUntilKey) {
    if (type !== 1) return;
    skipUntilKey = false;
  }
  const buf = new ArrayBuffer(17 + chunk.byteLength);
  const view = new DataView(buf);
  view.setUint8(0, type | HAS_SENT_AT);
  view.setFloat64(1, chunk.timestamp);
  view.setFloat64(9, Date.now());
  chunk.copyTo(new Uint8Array(buf, 17));
  ws.send(buf);
}

function startEncoding() {
  if (encoder) return;
  const videoTrack = stream.getVideoTracks()[0].clone();
  const audioTrack = stream.getAudioTracks()[0]?.clone();
  let stopped = false;
  let forceKey = true;
  let lastKeyRequest = 0;
  let frameNo = 0;
  let size = null;
  let bitrate = MAX_BITRATE;
  let reconfigure = false;
  let calmSeconds = 0;
  skipUntilKey = false;
  congested = false;

  const videoEncoder = new VideoEncoder({
    output: (chunk) => sendPacket(chunk.type === 'key' ? 1 : 2, chunk),
    error: (e) => console.error('VideoEncoder', e),
  });

  // Подстраиваем битрейт под интернет хоста: при пропусках снижаем, при свободном канале
  // постепенно возвращаем качество. Меньше данных в очереди — меньше задержка у зрителей.
  const bitrateTimer = setInterval(() => {
    if (congested) {
      calmSeconds = 0;
      if (bitrate > MIN_BITRATE) {
        bitrate = Math.max(MIN_BITRATE, Math.round(bitrate * 0.7));
        reconfigure = true;
      }
    } else if (++calmSeconds >= 8 && bitrate < MAX_BITRATE) {
      calmSeconds = 0;
      bitrate = Math.min(MAX_BITRATE, Math.round(bitrate * 1.2));
      reconfigure = true;
    }
    congested = false;
  }, 1000);

  (async () => {
    const reader = new MediaStreamTrackProcessor({ track: videoTrack }).readable.getReader();
    while (!stopped) {
      const { value: frame, done } = await reader.read();
      if (done) break;
      // Размер окна мог поменяться — перенастраиваем кодировщик
      const resized = !size || frame.displayWidth !== size.width || frame.displayHeight !== size.height;
      if (resized || reconfigure) {
        size = { width: frame.displayWidth, height: frame.displayHeight };
        videoEncoder.configure({ codec: 'vp8', ...size, bitrate, framerate: FPS, latencyMode: 'realtime' });
        if (resized) send({ t: 'media-config', config: { video: { codec: 'vp8', ...size } } });
        reconfigure = false;
        forceKey = true;
      }
      if (videoEncoder.encodeQueueSize > 2) { frame.close(); continue; } // не успеваем — пропускаем кадр
      const keyFrame = forceKey || frameNo % (FPS * 3) === 0;
      forceKey = false;
      frameNo++;
      videoEncoder.encode(frame, { keyFrame });
      frame.close();
    }
  })().catch((e) => console.error(e));

  let audioEncoder = null;
  if (audioTrack) {
    audioEncoder = new AudioEncoder({
      output: (chunk) => sendPacket(3, chunk),
      error: (e) => console.error('AudioEncoder', e),
    });
    (async () => {
      const reader = new MediaStreamTrackProcessor({ track: audioTrack }).readable.getReader();
      while (!stopped) {
        const { value: data, done } = await reader.read();
        if (done) break;
        if (audioEncoder.state === 'unconfigured') {
          const audio = { codec: 'opus', sampleRate: data.sampleRate, numberOfChannels: data.numberOfChannels };
          audioEncoder.configure({ ...audio, bitrate: 128_000 });
          send({ t: 'media-config', config: { audio } });
        }
        audioEncoder.encode(data);
        data.close();
      }
    })().catch((e) => console.error(e));
  }

  encoder = {
    requestKey() {
      // Не чаще раза в полсекунды, иначе ключевые кадры забьют канал
      if (Date.now() - lastKeyRequest < 500) return;
      lastKeyRequest = Date.now();
      forceKey = true;
    },
    stop() {
      stopped = true;
      clearInterval(bitrateTimer);
      videoTrack.stop();
      audioTrack?.stop();
      if (videoEncoder.state !== 'closed') videoEncoder.close();
      if (audioEncoder && audioEncoder.state !== 'closed') audioEncoder.close();
    },
  };
}

function stopEncoding() {
  encoder?.stop();
  encoder = null;
}

// ---------- Обязательное обновление ----------
window.bt.onUpdateRequired((version) => {
  disconnect();
  $('update').hidden = false;
  $('update-text').textContent = `Browser Together ${version} is available. Update to continue.`;
});

$('update-button').addEventListener('click', () => {
  $('update-button').disabled = true;
  $('update-button').lastChild.textContent = 'Downloading…';
  $('update-progress').hidden = false;
  window.bt.startUpdate();
});

window.bt.onUpdateProgress((percent) => {
  $('update-bar').style.width = `${Math.round(percent)}%`;
  $('update-button').lastChild.textContent = `Downloading… ${Math.round(percent)}%`;
});

window.bt.onUpdateInstalling(() => {
  $('update-bar').style.width = '100%';
  $('update-button').lastChild.textContent = 'Installing…';
});

window.bt.onUpdateError(() => {
  $('update-progress').hidden = true;
  $('update-bar').style.width = '0';
  $('update-button').disabled = false;
  $('update-button').lastChild.textContent = 'Retry';
  $('update-text').textContent = 'Update failed. Check your internet connection and try again.';
  $('update-manual').hidden = false;
});

// Запасной путь, если автообновление не сработало: скачать установщик в браузере
$('update-manual').addEventListener('click', () => window.bt.downloadInstaller());

showCodeForm();
