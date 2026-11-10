// Интерфейс Протоколиста
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const fmt = sec => { sec = Math.max(0, Math.floor(sec || 0)); const h = Math.floor(sec / 3600), m = Math.floor(sec / 60) % 60, s = sec % 60, p = x => String(x).padStart(2, "0"); return h ? `${h}:${p(m)}:${p(s)}` : `${p(m)}:${p(s)}`; };
const ruDate = iso => iso ? iso.split("-").reverse().join(".") : "";
const size = b => b >= 1073741824 ? (b / 1073741824).toFixed(1).replace(".", ",") + " ГБ" : b >= 1048576 ? Math.round(b / 1048576) + " МБ" : Math.max(1, Math.round(b / 1024)) + " КБ";
const plural = (n, a, b, c) => (n % 10 === 1 && n % 100 !== 11 ? a : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? b : c);
let state = { config: null, templates: [], transcript: null, file: null, micFile: null, recFiles: [], result: null, ready: false, view: "record" };
let busy = false;

// ── Сообщения в интерфейсе вместо системных окон
function toast(text, kind = "info", ms = 6000) {
  const t = document.createElement("div");
  t.className = "toast " + kind;
  t.textContent = text;
  t.onclick = () => t.remove();
  $("#toasts").append(t);
  setTimeout(() => t.remove(), ms);
}

function show(view) {
  state.view = view;
  $$("main > section").forEach(s => (s.hidden = s.id !== "v-" + view));
  $$("nav button").forEach(b => b.classList.toggle("on", b.dataset.view === view));
  if (view === "archive") loadArchive();
  if (view === "tasks") loadTasks();
  if (view === "settings") fillSettings();
  if (view !== "record") stopMicTest();
}
// переходить по вкладкам можно всегда: загрузка и обработка идут в фоне, вернуться — по плашке слева
$$("nav button").forEach(b => b.addEventListener("click", () => show(b.dataset.view)));
$$("[data-go]").forEach(b => b.addEventListener("click", () => show(b.dataset.go)));

const job = { kind: null };
function setJob(kind, title, p, sub) {
  job.kind = kind;
  $("#job").hidden = !kind;
  if (!kind) return;
  $("#job-t").textContent = title;
  $("#job .bar i").style.width = Math.round((p ?? 0) * 100) + "%";
  $("#job-s").textContent = sub ?? "";
}
$("#job").addEventListener("click", () => show(job.kind === "download" ? "setup" : "work"));

function setNet(n) {
  const kb = n.sentBytes;
  $("#net span").textContent = `Сеть: ${kb < 1024 ? kb + " байт" : (kb / 1024).toFixed(1) + " КБ"}`;
  $("#net").classList.toggle("sent", kb > 0);
  $("#net small").textContent = kb > 0 ? "отправлено в интеграции или облако по вашей команде" : "всё обрабатывается на этом компьютере";
}
pk.on("net", setNet);
const setBusy = v => { busy = v; pk.setState({ busy: v }); };

// ── Старт
function setReady(ready) {
  state.ready = ready;
  $$(".gate").forEach(g => (g.hidden = ready));
  $("#gate").hidden = ready;
  $("#rec").disabled = !ready;
  $("#pick").disabled = !ready;
  $("#drop").classList.toggle("off", !ready);
}
async function init() {
  $("#ver").textContent = "v" + (await pk.version());
  const st = await pk.core("status");
  state.config = st.config;
  state.templates = st.templates;
  setNet(st.net);
  const opts = st.templates.map(t => `<option value="${esc(t.id)}">${esc(t.title)}</option>`).join("");
  $("#tpl").innerHTML = opts;
  $("#tpl-def").innerHTML = opts;
  $("#packs").innerHTML = st.packs.map(p => `<li><span>${esc(p.title)}<small> · лицензия ${esc(p.license)}</small></span><b>${p.missing ? size(p.size) : "✓ скачано"}</b></li>`).join("");
  $("#dl-total").textContent = st.left ? `осталось ${size(st.left)} из ≈ ${size(st.packs.reduce((a, p) => a + p.size, 0))}` : "всё скачано";
  setReady(!st.missing.length);
  if (st.missing.length) { show("setup"); if (st.downloading) startDownload(); }
  listMics();
  recoverOrphans();
}

// ── Загрузка моделей: фоновая задача
let dl = null;
async function startDownload() {
  if (dl) return;
  dl = { t0: Date.now(), from: null };
  $("#dl").disabled = true;
  $("#dl").textContent = "Скачиваем…";
  $("#dl-box").hidden = false;
  setJob("download", "Скачиваем модели", 0, "");
  try {
    await pk.core("download");
    setJob(null);
    setReady(true);
    toast("Модели скачаны. Можно записывать встречи — интернет больше не нужен.", "ok");
    $$("#packs b").forEach(b => (b.textContent = "✓ скачано"));
    if (state.view === "setup") show("record");
  } catch (e) {
    setJob(null);
    $("#dl-info").textContent = e.message;
    $("#dl-info").classList.add("err");
    toast("Загрузка прервалась. Нажмите «Продолжить» — скачанное не пропадёт.", "err", 10000);
    $("#dl").textContent = "Продолжить загрузку";
    $("#dl").disabled = false;
  }
  dl = null;
}
$("#dl").addEventListener("click", startDownload);

// ── Прогресс
const STAGES = [["decode", "Чтение"], ["vad", "Поиск речи"], ["speakers", "Голоса"], ["asr", "Распознавание"], ["protocol", "Протокол"]];
const FILE_NAMES = { "asr/encoder.int8.onnx": "распознавание речи", "asr/decoder.onnx": "распознавание речи", "asr/joiner.onnx": "распознавание речи", "asr/tokens.txt": "словарь распознавания", "vad/silero_vad.onnx": "поиск речи", "speaker/campplus.onnx": "голоса участников", "llm/qwen3-4b-instruct-2507-q4_k_m.gguf": "языковая модель для протокола" };
pk.on("progress", m => {
  if (m.stage === "download") {
    if (!dl) dl = { t0: Date.now(), from: null };
    $("#dl-box").hidden = false;
    $("#dl").disabled = true;
    dl.from ??= { done: m.done, at: Date.now() };
    const p = m.total ? m.done / m.total : 0;
    const sec = (Date.now() - dl.from.at) / 1000;
    const speed = sec > 2 ? (m.done - dl.from.done) / sec : 0;
    const eta = speed > 0 ? (m.total - m.done) / speed : 0;
    $("#dlbar i").style.width = p * 100 + "%";
    $("#dlbar span").textContent = `${size(m.done)} из ${size(m.total)} · ${Math.floor(p * 100)}%`;
    $("#dl-info").classList.remove("err");
    $("#dl-info").textContent = `Файл ${m.index + 1} из ${m.count}: ${FILE_NAMES[m.file] ?? m.file} (${size(m.fileDone)} из ${size(m.fileTotal)})${speed ? ` · ${size(speed)}/с · осталось ≈ ${fmt(eta)}` : ""}`;
    setJob("download", "Скачиваем модели", p, `${Math.floor(p * 100)}%${speed ? " · ≈ " + fmt(eta) : ""}`);
    return;
  }
  const i = STAGES.findIndex(s => s[0] === m.stage);
  $$("#steps div").forEach((d, k) => { d.classList.toggle("on", k === i); d.classList.toggle("done", k < i); });
  const p = m.total ? m.done / m.total : 0;
  $("#wbar i").style.width = p * 100 + "%";
  $("#wbar span").textContent = Math.round(p * 100) + "%";
  if (busy) setJob("work", STAGES[i]?.[1] ?? "Обработка", (i + p) / STAGES.length, Math.round(p * 100) + "%");
});

// ── Микрофон: выбор устройства, проверка уровня, шумоподавление
async function listMics() {
  try {
    const devs = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === "audioinput" && d.deviceId !== "default" && d.deviceId !== "communications");
    const saved = localStorage.getItem("mic") ?? "";
    $("#mic-dev").innerHTML = `<option value="">По умолчанию в системе</option>` + devs.map((d, i) => `<option value="${esc(d.deviceId)}">${esc(d.label || "Микрофон " + (i + 1))}</option>`).join("");
    if (devs.some(d => d.deviceId === saved)) $("#mic-dev").value = saved;
  } catch { /* нет доступа к списку — остаётся «по умолчанию» */ }
}
navigator.mediaDevices.addEventListener?.("devicechange", listMics);
$("#mic-dev").addEventListener("change", e => { localStorage.setItem("mic", e.target.value); if (micTest) { stopMicTest(); startMicTest(); } });
$("#mic-ns").checked = localStorage.getItem("mic-ns") === "1";
$("#mic-ns").addEventListener("change", e => localStorage.setItem("mic-ns", e.target.checked ? "1" : "0"));
const micConstraints = () => {
  const ns = $("#mic-ns").checked, id = $("#mic-dev").value;
  // эхоподавление оставляем: без него в микрофон попадает звук из колонок. Шумодав — по выбору.
  return { audio: { ...(id ? { deviceId: { exact: id } } : {}), echoCancellation: true, noiseSuppression: ns, autoGainControl: true, channelCount: 1 } };
};

function meter(stream, el, onLevel) {
  const ctx = new AudioContext();
  const an = ctx.createAnalyser();
  an.fftSize = 1024;
  ctx.createMediaStreamSource(stream).connect(an);
  const buf = new Float32Array(an.fftSize);
  let alive = true;
  (function tick() {
    if (!alive) return;
    an.getFloatTimeDomainData(buf);
    let sum = 0;
    for (const v of buf) sum += v * v;
    const rms = Math.sqrt(sum / buf.length);
    // шкала в дБ: тихая речь в гарнитуре тоже видна
    const lvl = Math.max(0, Math.min(1, (20 * Math.log10(rms + 1e-8) + 60) / 50));
    el.style.width = lvl * 100 + "%";
    onLevel?.(lvl);
    requestAnimationFrame(tick);
  })();
  return () => { alive = false; el.style.width = 0; ctx.close(); };
}

let micTest = null;
async function startMicTest() {
  try {
    const s = await navigator.mediaDevices.getUserMedia(micConstraints());
    let peak = 0;
    const stop = meter(s, $("#m-mic i"), l => (peak = Math.max(peak, l)));
    const t = setTimeout(() => { if (micTest && peak < 0.25) { $("#mic-hint").textContent = "Почти не слышно. Выберите другой микрофон или проверьте, что гарнитура подключена"; $("#mic-hint").classList.add("err"); } }, 5000);
    micTest = { s, stop, t };
    listMics();
    $("#mic-test").textContent = "Остановить проверку";
    $("#mic-hint").classList.remove("err");
    $("#mic-hint").textContent = "Скажите пару слов — полоска «Микрофон» должна двигаться";
  } catch (e) { toast(micError(e), "err"); }
}
function stopMicTest() {
  if (!micTest) return;
  clearTimeout(micTest.t);
  micTest.stop();
  micTest.s.getTracks().forEach(t => t.stop());
  micTest = null;
  $("#mic-test").textContent = "Проверить микрофон";
}
$("#mic-test").addEventListener("click", () => (micTest ? stopMicTest() : startMicTest()));
const micError = e => e?.name === "NotAllowedError" ? "Нет доступа к микрофону. Windows: Параметры → Конфиденциальность → Микрофон → разрешить приложениям. macOS: Системные настройки → Конфиденциальность → Микрофон." : e?.name === "NotFoundError" || e?.name === "OverconstrainedError" ? "Микрофон не найден. Подключите гарнитуру или выберите другой микрофон." : e?.name === "NotReadableError" ? "Микрофон занят другой программой или отключён." : e?.message ?? String(e);

// ── Запись: куски пишутся на диск каждую секунду
let rec = null, starting = false;
$("#copy-consent").addEventListener("click", async () => { await navigator.clipboard.writeText($("#consent-text").textContent); toast("Текст скопирован — вставьте его в чат встречи", "ok", 3000); });
$("#rec").addEventListener("click", () => (rec ? stopRec() : startRec()));
pk.on("meeting", m => {
  if (rec || busy || starting || !state.ready) return;
  if (m.start) { show("record"); startRec(); return; }
  const b = document.createElement("div");
  b.className = "banner";
  b.innerHTML = `<span>Похоже, началась встреча в ${esc(m.app)}.</span><button class="primary">Записать</button>`;
  b.querySelector("button").onclick = () => { b.remove(); show("record"); startRec(); };
  $("#v-record").prepend(b);
  setTimeout(() => b.remove(), 60000);
});

async function startRec() {
  if (rec || starting || busy) return; // двойной клик и запуск поверх обработки
  if (!state.ready) return toast("Сначала скачайте модели", "err");
  const useSys = $("#rec-sys").checked, useMic = $("#rec-mic").checked;
  if (!useSys && !useMic) return toast("Отметьте, что записывать: звук компьютера, микрофон или оба", "err");
  starting = true;
  $("#rec").disabled = true;
  stopMicTest();
  const tracks = [], parts = {};
  try {
    if (useSys) {
      const ds = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      const a = ds.getAudioTracks();
      ds.getVideoTracks().forEach(t => t.stop()); // видео не нужно
      if (!a.length) throw new Error((await pk.platform()) === "darwin" ? "Нет доступа к звуку. Разрешите Протоколисту «Запись экрана и системного звука» в Системных настройках → Конфиденциальность (нужна macOS 14.2+)." : "Не удалось получить звук компьютера");
      tracks.push(...a);
      parts.sys = new MediaStream(a);
    }
    if (useMic) {
      const ms = await navigator.mediaDevices.getUserMedia(micConstraints()).catch(e => { throw new Error(micError(e)); });
      tracks.push(...ms.getTracks());
      parts.mic = ms;
    }
  } catch (e) { tracks.forEach(t => t.stop()); starting = false; $("#rec").disabled = false; return toast(e.message, "err", 10000); }
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  const recorders = {}, stops = [], files = {}, writes = [];
  let quiet = 0, heard = false;
  for (const [k, s] of Object.entries(parts)) {
    files[k] = await pk.recPath(`${stamp}-${k}.webm`);
    recorders[k] = new MediaRecorder(s, { mimeType: "audio/webm;codecs=opus", audioBitsPerSecond: 64000 });
    // куски дописываются строго по порядку: цепочка промисов на каждую дорожку
    let chain = Promise.resolve();
    recorders[k].ondataavailable = e => { if (e.data.size) { const d = e.data; chain = chain.then(async () => pk.recChunk(`${stamp}-${k}.webm`, new Uint8Array(await d.arrayBuffer()))); writes.push(chain); } };
    recorders[k].start(1000);
    stops.push(meter(s, $(k === "mic" ? "#m-mic i" : "#m-sys i"), k === "mic" ? l => { if (l > 0.3) heard = true; } : undefined));
    // гарнитуру выдернули — продолжаем писать звук компьютера
    s.getAudioTracks().forEach(t => t.addEventListener("ended", () => { if (rec) { $("#mic-warn").hidden = false; $("#mic-warn").textContent = k === "mic" ? "Микрофон отключился. Звук компьютера продолжает записываться." : "Звук компьютера перестал записываться."; } }));
  }
  const t0 = Date.now();
  const timer = setInterval(() => {
    $("#timer").textContent = fmt((Date.now() - t0) / 1000);
    // через 8 секунд тишины в микрофоне — подсказка
    if (parts.mic && !heard && ++quiet === 16) { $("#mic-warn").hidden = false; $("#mic-warn").textContent = "Микрофон почти не слышно. Проверьте, что выбрана нужная гарнитура и она не выключена."; }
    if (heard && quiet < 16) $("#mic-warn").hidden = true;
  }, 500);
  rec = { recorders, tracks, stops, timer, t0, files, writes };
  starting = false;
  pk.setState({ recording: true });
  $("#rec").disabled = false;
  $("#rec").textContent = "■ Остановить и расшифровать";
  $("#rec").classList.add("rec");
  $$("#rec-sys, #rec-mic, #mic-dev, #mic-ns, #mic-test").forEach(x => (x.disabled = true));
}

async function stopRec() {
  const r = rec;
  if (!r || r.stopping) return;
  r.stopping = true;
  $("#rec").disabled = true;
  clearInterval(r.timer);
  r.stops.forEach(f => f());
  await Promise.all(Object.values(r.recorders).map(m => new Promise(res => { m.onstop = res; m.stop(); })));
  r.tracks.forEach(t => t.stop());
  await Promise.all(r.writes);
  rec = null;
  pk.setState({ recording: false });
  $("#rec").disabled = false;
  $("#rec").textContent = "● Начать запись";
  $("#rec").classList.remove("rec");
  $("#mic-warn").hidden = true;
  $$("#rec-sys, #rec-mic, #mic-dev, #mic-ns, #mic-test").forEach(x => (x.disabled = false));
  if ((Date.now() - r.t0) < 1500) return toast("Запись слишком короткая — запишите хотя бы пару секунд", "err");
  // основной файл — звук встречи; микрофон — отдельной дорожкой «Я». Живая встреча — только микрофон.
  process(r.files.sys ?? r.files.mic, r.files.sys ? r.files.mic : undefined, Object.values(r.files));
}

// Незаконченные записи после сбоя или закрытия окна
async function recoverOrphans() {
  const list = await pk.recOrphans();
  for (const o of list) {
    const b = document.createElement("div");
    b.className = "banner";
    b.innerHTML = `<span>Есть незавершённая запись от ${esc(o.stamp.slice(0, 10).split("-").reverse().join("."))} ${esc(o.stamp.slice(11, 16).replace("-", ":"))} (${size(o.bytes)}).</span><span><button class="primary">Расшифровать</button> <button class="ghost">Удалить</button></span>`;
    const [go, del] = b.querySelectorAll("button");
    go.onclick = () => { if (busy || !state.ready) return toast(state.ready ? "Дождитесь окончания обработки" : "Сначала скачайте модели", "err"); b.remove(); process(o.sys ?? o.mic, o.sys ? o.mic : undefined, [o.sys, o.mic].filter(Boolean)); };
    del.onclick = async () => { await pk.recDone([o.sys, o.mic].filter(Boolean)); b.remove(); };
    $("#v-record").prepend(b);
  }
}

// ── Файл
const AUDIO = /\.(wav|mp3|m4a|ogg|oga|opus|webm|mp4|mkv|mov|aac|flac|wma|amr|3gp|avi)$/i;
$("#pick").addEventListener("click", async () => { if (busy) return toast("Дождитесь окончания обработки", "err"); const f = await pk.pickFile(); if (f) process(f); });
const drop = $("#drop");
drop.addEventListener("dragover", e => { e.preventDefault(); drop.classList.add("over"); });
drop.addEventListener("dragleave", () => drop.classList.remove("over"));
drop.addEventListener("drop", e => {
  e.preventDefault();
  drop.classList.remove("over");
  if (!state.ready) return toast("Сначала скачайте модели", "err");
  if (busy) return toast("Дождитесь окончания обработки текущей встречи", "err");
  const files = [...e.dataTransfer.files];
  if (files.length > 1) toast("Беру первый файл — встречи расшифровываются по одной");
  const f = files[0];
  if (!f) return;
  if (!AUDIO.test(f.name)) return toast(`«${f.name}» не похож на запись. Подойдут аудио и видео: mp3, m4a, wav, ogg, webm, mp4 и другие.`, "err", 8000);
  process(pk.pathOf(f));
});
// файл, брошенный мимо зоны, не должен открываться в окне
window.addEventListener("dragover", e => e.preventDefault());
window.addEventListener("drop", e => e.preventDefault());

// ── Обработка
async function process(file, micFile, recFiles = []) {
  if (busy) return;
  setBusy(true);
  state.file = file;
  state.micFile = micFile;
  state.recFiles = recFiles;
  show("work");
  $("#w-title").textContent = "Распознаём речь";
  $("#speakers").hidden = true;
  $("#steps").innerHTML = STAGES.map(s => `<div>${s[1]}</div>`).join("");
  $("#wbar").hidden = false;
  setJob("work", "Распознаём речь", 0, "");
  try {
    const tr = await pk.core("transcribe", { file, micFile });
    state.transcript = tr;
    const n = tr.speakers.length;
    $("#w-title").textContent = `${fmt(tr.duration)} · ${n} ${plural(n, "участник", "участника", "участников")} · распознано за ${fmt(tr.stats.asrSeconds + tr.stats.diarSeconds)}`;
    $("#wbar").hidden = true;
    setJob("work", "Подпишите участников", 0.8, "ждём вас");
    $("#sp-list").innerHTML = tr.speakers.map(s => {
      const first = tr.segments.find(x => x.speaker === s.id);
      return `<div class="sp"><span>${esc(s.label)} · ${fmt(s.talk)}</span><input data-sp="${esc(s.id)}" maxlength="60" placeholder="${esc(s.id === "me" ? "Я (ваше имя)" : "Имя")}"><q title="${esc(first?.text)}">${esc(first?.text ?? "")}</q></div>`;
    }).join("") || `<p class="note">Речь не найдена. Проверьте, что в записи есть звук.</p>`;
    $("#tpl").value = state.config.template;
    $("#speakers").hidden = false;
    $("#make").disabled = $("#only-tr").disabled = false;
  } catch (e) { fail(e); }
}

async function makeProtocol(noProtocol) {
  if (!state.transcript || $("#make").disabled) return;
  $("#make").disabled = $("#only-tr").disabled = true;
  const names = Object.fromEntries($$("#sp-list input").filter(i => i.value.trim()).map(i => [i.dataset.sp, i.value.trim().slice(0, 60)]));
  $("#speakers").hidden = true;
  $("#wbar").hidden = false;
  $("#w-title").textContent = noProtocol ? "Сохраняем стенограмму" : "Составляем протокол на этом компьютере";
  setJob("work", noProtocol ? "Сохраняем" : "Составляем протокол", 0.85, "");
  try {
    const agenda = $("#agenda").value.split("\n").map(s => s.trim()).filter(Boolean).slice(0, 30);
    const r = await pk.core("protocol", { transcript: state.transcript, file: state.file, micFile: state.micFile, names, template: $("#tpl").value, agenda, keepAudio: $("#keep").checked, noProtocol });
    // запись уже сведена в папку встречи — черновые дорожки больше не нужны
    pk.recDone(state.recFiles);
    showResult(r);
  } catch (e) { fail(e); }
}
$("#make").addEventListener("click", () => makeProtocol(false));
$("#only-tr").addEventListener("click", () => makeProtocol(true));

function fail(e) {
  setBusy(false);
  setJob(null);
  show("result");
  $("#r-title").textContent = "Не получилось";
  $("#r-summary").textContent = e.message.replace(/^Error invoking remote method 'core': (Error: )?/, "");
  $("#r-stats").innerHTML = $("#r-tasks").innerHTML = "";
  $$("#r-open, #r-folder, #r-b24, #r-yg, #r-tg").forEach(b => (b.hidden = true));
  $("#r-note").textContent = state.recFiles.length ? "Запись сохранена — её можно расшифровать заново на вкладке «Запись». " : "";
  $("#r-note").textContent += "Если ошибка повторяется — сообщите на github.com/kozhevnikovai/protokolist/issues (без записи с личными данными).";
}

function showResult(r) {
  setBusy(false);
  setJob(null);
  state.result = r;
  show("result");
  if (document.hidden || !document.hasFocus()) new Notification("Протоколист", { body: r.protocol ? "Протокол готов" : "Стенограмма готова" });
  const p = r.protocol;
  $("#r-title").textContent = p?.title ?? "Стенограмма готова";
  $("#r-summary").textContent = p?.summary ?? "";
  const review = p ? p.tasks.filter(t => t.review).length : 0;
  $("#r-stats").innerHTML = p ? `<div>Решений<b>${p.decisions.length}</b></div><div>Задач<b>${p.tasks.length}</b></div><div>Проверить<b>${review}</b></div><div>Модель<b style="font-size:12px">${esc(p.meta.model)}</b></div><div>В сеть<b>${r.netBytes} Б</b></div>` : "";
  $("#r-tasks").innerHTML = p?.tasks.length ? `<table><tr><th>Задача</th><th>Ответственный</th><th>Срок</th></tr>${p.tasks.map(t => `<tr><td>${esc(t.text)}${t.review ? '<div class="review">● проверить по записи</div>' : ""}</td><td>${esc(t.owner || "—")}</td><td>${t.due ? ruDate(t.due) : esc(t.dueText || "—")}</td></tr>`).join("")}</table>` : "";
  const c = state.config, set = c.secretsSet ?? {};
  const can = !c.offline && !!p?.tasks.length;
  $("#r-open").hidden = $("#r-folder").hidden = false;
  $("#r-b24").hidden = !(can && set["bitrix24.webhook"]);
  $("#r-yg").hidden = !(can && set["yougile.key"]);
  $("#r-tg").hidden = !(!c.offline && p && set["telegram.token"]);
  $("#r-note").classList.remove("err");
  $("#r-note").textContent = c.offline && (set["bitrix24.webhook"] || set["yougile.key"] || set["telegram.token"]) ? "Подключения настроены, но включён строгий офлайн — выключите его в настройках, чтобы отправлять задачи." : "";
}
const htmlFile = () => state.result.files.find(f => f.endsWith(".html")) ?? state.result.dir;
$("#r-open").addEventListener("click", () => pk.open(htmlFile()));
$("#r-folder").addEventListener("click", () => pk.open(state.result.dir));
for (const [id, target] of [["#r-b24", "bitrix24"], ["#r-yg", "yougile"], ["#r-tg", "telegram"]]) $(id).addEventListener("click", async () => {
  if ($(id).disabled) return;
  $(id).disabled = true; // повторный клик не создаёт задачи дважды
  try {
    const [res] = await pk.core("send", { dir: state.result.dir, targets: [target] });
    $("#r-note").classList.toggle("err", !!res.failed.length);
    $("#r-note").textContent = `${res.target}: отправлено ${res.ok}${res.failed.length ? `, ошибки: ${res.failed.map(f => f.error).join("; ")}` : ""}`;
    if (!res.failed.length) { $(id).textContent = "✓ " + res.target; return; }
  } catch (e) { $("#r-note").textContent = e.message; $("#r-note").classList.add("err"); }
  $(id).disabled = false;
});

// ── Архив
async function loadArchive() {
  let ms = [];
  try { ms = await pk.core("list"); } catch (e) { toast("Не удалось открыть папку протоколов: " + e.message, "err"); }
  $("#meetings").innerHTML = ms.length ? `<tr><th>Дата</th><th>Встреча</th><th>Длит.</th><th>Задач</th></tr>${ms.map(m => `<tr data-file="${esc(m.file)}"><td>${ruDate(m.date)}</td><td>${esc(m.title)}</td><td>${fmt(m.duration)}</td><td>${m.tasks}</td></tr>`).join("")}` : `<tr><td>Пока нет встреч. Запишите первую.</td></tr>`;
  $$("#meetings tr[data-file]").forEach(tr => tr.addEventListener("click", () => pk.open(tr.dataset.file)));
}
let qt, qn = 0;
$("#q").addEventListener("input", e => {
  clearTimeout(qt);
  qt = setTimeout(async () => {
    const q = e.target.value.trim().slice(0, 200);
    const my = ++qn; // ответы на старые запросы не перетирают новые
    if (q.length < 2) return ($("#hits").innerHTML = "");
    const hits = await pk.core("search", { query: q }).catch(() => []);
    if (my !== qn) return;
    $("#hits").innerHTML = hits.length ? hits.slice(0, 100).map(h => `<div class="hit" data-file="${esc(h.file)}"><span>${ruDate(h.date)} · ${esc(h.where)}${h.at !== null ? " · " + fmt(h.at) : ""}</span><br>${esc(h.text)} <span>— ${esc(h.title)}</span></div>`).join("") : `<p class="note">Ничего не нашлось</p>`;
    $$(".hit").forEach(el => el.addEventListener("click", () => pk.open(el.dataset.file)));
  }, 250);
});

// ── Задачи из всех протоколов
let allTasks = [];
async function loadTasks() {
  try { allTasks = await pk.core("tasks"); } catch (e) { toast("Не удалось прочитать протоколы: " + e.message, "err"); allTasks = []; }
  renderTasks();
}
function renderTasks() {
  const today = new Date().toISOString().slice(0, 10), week = new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10);
  const list = $("#t-mine").checked ? allTasks.filter(t => !t.owner || !t.due) : allTasks;
  $("#t-all").textContent = allTasks.length;
  $("#t-week").textContent = allTasks.filter(t => t.due && t.due >= today && t.due <= week).length;
  $("#t-review").textContent = allTasks.filter(t => t.review).length;
  $("#t-table").innerHTML = list.length ? `<tr><th>Задача</th><th>Ответственный</th><th>Срок</th><th>Встреча</th></tr>${list.slice(0, 500).map(t => {
    const cls = t.due && t.due < today ? "overdue" : t.due && t.due <= week ? "due-soon" : "";
    return `<tr data-file="${esc(t.file)}"><td>${esc(t.text)}${t.review ? '<div class="review">● проверить по записи</div>' : ""}</td><td>${esc(t.owner || "—")}</td><td class="${cls}">${t.due ? ruDate(t.due) : esc(t.dueText || "—")}</td><td>${esc(t.meeting)}<br><span class="note">${ruDate(t.date)}</span></td></tr>`;
  }).join("")}` : `<tr><td>Задач пока нет — они появятся после первого протокола.</td></tr>`;
  $$("#t-table tr[data-file]").forEach(tr => tr.addEventListener("click", () => pk.open(tr.dataset.file)));
}
$("#t-mine").addEventListener("change", renderTasks);

// ── Настройки
const get = (o, k) => k.split(".").reduce((a, x) => a?.[x], o);
function fillSettings() {
  const set = state.config.secretsSet ?? {};
  for (const el of $$("[data-k]")) {
    const v = get(state.config, el.dataset.k);
    if (el.type === "checkbox") el.checked = !!v;
    else el.value = Array.isArray(v) ? v.join(",") : v ?? "";
    if (el.type === "password") el.placeholder = set[el.dataset.k] ? "сохранён · введите новый, чтобы заменить" : el.dataset.ph ?? (el.dataset.ph = el.placeholder);
  }
  for (const [svc, key] of [["bitrix24", "bitrix24.webhook"], ["yougile", "yougile.key"], ["telegram", "telegram.token"]]) {
    const st = $(`[data-st="${svc}"]`);
    st.textContent = set[key] ? "настроено" : "не подключено";
    st.classList.toggle("on", !!set[key]);
    $(`[data-clear="${key}"]`).hidden = !set[key];
  }
}
$("#pickdir").addEventListener("click", async () => { const d = await pk.pickDir(); if (d) $("#outdir").value = d; });
function collect() {
  const patch = {};
  for (const el of $$("[data-k]")) {
    let v = el.type === "checkbox" ? el.checked : el.type === "number" ? Math.max(0, Number(el.value) || 0) : el.value.trim();
    if (el.dataset.k === "formats") v = String(v).split(/[,\s;]+/).map(s => s.trim().toLowerCase()).filter(Boolean);
    const path = el.dataset.k.split(".");
    let cur = patch;
    path.slice(0, -1).forEach(p => (cur = cur[p] ??= {}));
    cur[path.at(-1)] = v;
  }
  return patch;
}
async function save(patch) {
  try {
    state.config = await pk.core("saveConfig", { patch });
    fillSettings();
    return true;
  } catch (e) { toast("Не удалось сохранить: " + e.message, "err"); return false; }
}
$("#save").addEventListener("click", async () => {
  const patch = collect();
  const bad = String(patch.formats ?? "").split(",").filter(f => f && !["html", "docx", "md", "json", "txt", "srt", "ics"].includes(f));
  if (bad.length) toast(`Неизвестные форматы пропущены: ${bad.join(", ")}. Доступны: html, docx, md, json, txt, srt, ics`, "err", 8000);
  if (await save(patch)) toast("Настройки сохранены", "ok", 2500);
});
$$("[data-clear]").forEach(b => b.addEventListener("click", async () => {
  const patch = {};
  const [g, k] = b.dataset.clear.split(".");
  patch[g] = { [k]: "\u0000clear" };
  if (await save(patch)) toast("Подключение отключено", "ok", 2500);
}));
$$("[data-check]").forEach(b => b.addEventListener("click", async () => {
  const svc = b.dataset.check;
  const cfg = collect()[svc] ?? {};
  const res = $(`[data-res="${svc}"]`);
  b.disabled = true;
  res.className = "note";
  res.textContent = "Проверяем…";
  try {
    const r = await pk.check(svc, cfg);
    res.textContent = (r.ok ? "✓ " : "✕ ") + r.message;
    res.classList.add(r.ok ? "ok" : "err");
    if (r.ok) await save({ [svc]: cfg }); // проверенное подключение сразу сохраняем
  } catch (e) { res.textContent = "✕ " + e.message; res.classList.add("err"); }
  b.disabled = false;
}));

init().catch(e => toast("Не удалось запустить: " + e.message, "err", 15000));
