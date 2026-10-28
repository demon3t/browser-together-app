// Панель приложения: адресная строка + трансляция вкладки на сервер Browser Together.
const $ = (id) => document.getElementById(id);

const FPS = 30;
const VIDEO_BITRATE = 2_500_000;
const MAX_WIDTH = 1280;
const MAX_HEIGHT = 720;

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
  $('reload').innerHTML = page.loading ? '&#10005;' : '&#8635;';
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

function showLive(text, state) {
  $('code-form').hidden = true;
  $('live').hidden = false;
  $('live').className = state || '';
  $('live-text').textContent = text;
}

function showCodeForm(error) {
  $('live').hidden = true;
  $('code-form').hidden = false;
  $('code-error').hidden = !error;
  $('code-error').textContent = error || '';
}

function updateLiveText() {
  const who = viewers === 1 ? 'зритель' : viewers >= 2 && viewers <= 4 ? 'зрителя' : 'зрителей';
  showLive(`В эфире · ${viewers} ${who} · код ${code}`, 'on');
}

async function connect(newCode) {
  config ??= await window.bt.getConfig();
  disconnect(true);
  code = newCode;
  $('code').value = code;
  showLive('Подключение...', '');

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
      showCodeForm(msg.error);
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
    showLive('Связь потеряна, переподключение...', 'error');
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

function sendPacket(type, chunk) {
  // Канал не успевает — пропускаем пакет, сервер дождётся следующего ключевого кадра
  if (ws?.readyState !== 1 || ws.bufferedAmount > 4 * 1024 * 1024) return;
  const buf = new ArrayBuffer(9 + chunk.byteLength);
  const view = new DataView(buf);
  view.setUint8(0, type);
  view.setFloat64(1, chunk.timestamp);
  chunk.copyTo(new Uint8Array(buf, 9));
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

  const videoEncoder = new VideoEncoder({
    output: (chunk) => sendPacket(chunk.type === 'key' ? 1 : 2, chunk),
    error: (e) => console.error('VideoEncoder', e),
  });

  (async () => {
    const reader = new MediaStreamTrackProcessor({ track: videoTrack }).readable.getReader();
    while (!stopped) {
      const { value: frame, done } = await reader.read();
      if (done) break;
      // Размер окна мог поменяться — перенастраиваем кодировщик
      if (!size || frame.displayWidth !== size.width || frame.displayHeight !== size.height) {
        size = { width: frame.displayWidth, height: frame.displayHeight };
        videoEncoder.configure({ codec: 'vp8', ...size, bitrate: VIDEO_BITRATE, framerate: FPS, latencyMode: 'realtime' });
        send({ t: 'media-config', config: { video: { codec: 'vp8', ...size } } });
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

showCodeForm();
