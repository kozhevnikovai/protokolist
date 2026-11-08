// Интерфейс Протоколиста
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const fmt = sec => { sec = Math.floor(sec); const h = Math.floor(sec / 3600), m = Math.floor(sec / 60) % 60, s = sec % 60, p = x => String(x).padStart(2, "0"); return h ? `${h}:${p(m)}:${p(s)}` : `${p(m)}:${p(s)}`; };
const ruDate = iso => iso ? iso.split("-").reverse().join(".") : "";
let state = { config: null, templates: [], transcript: null, file: null, micFile: null, result: null };

function show(view) {
  $$("main > section").forEach(s => (s.hidden = s.id !== "v-" + view));
  $$("nav button").forEach(b => b.classList.toggle("on", b.dataset.view === view));
  if (view === "archive") loadArchive();
  if (view === "settings") fillSettings();
}
$$("nav button").forEach(b => b.addEventListener("click", () => { if (!busy) show(b.dataset.view); }));
let busy = false;

function setNet(n) {
  const kb = n.sentBytes;
  $("#net span").textContent = `Сеть: ${kb < 1024 ? kb + " байт" : (kb / 1024).toFixed(1) + " КБ"}`;
  $("#net").classList.toggle("sent", kb > 0);
  $("#net small").textContent = kb > 0 ? "отправлено в интеграции или облако по вашей команде" : "всё обрабатывается на этом компьютере";
}
pk.on("net", setNet);

// ── Старт
async function init() {
  const st = await pk.core("status");
  state.config = st.config;
  state.templates = st.templates;
  setNet(st.net);
  const opts = st.templates.map(t => `<option value="${t.id}">${esc(t.title)}</option>`).join("");
  $("#tpl").innerHTML = opts;
  $("#tpl-def").innerHTML = opts;
  if (st.missing.length) {
    $("#packs").innerHTML = st.packs.map(p => `<li>${esc(p.title)} <small>· ${esc(p.license)}</small></li>`).join("");
    show("setup");
  }
}
$("#dl").addEventListener("click", async () => {
  $("#dl").disabled = true;
  $("#dlbar").hidden = false;
  try { await pk.core("download"); show("record"); } catch (e) { alert("Не удалось скачать модели: " + e.message + "\nПроверьте интернет и попробуйте ещё раз — загрузка продолжится."); $("#dl").disabled = false; }
});

// ── Прогресс
const STAGES = [["decode", "Чтение"], ["vad", "Поиск речи"], ["speakers", "Голоса"], ["asr", "Распознавание"], ["protocol", "Протокол"]];
pk.on("progress", m => {
  if (m.stage === "download") {
    const p = m.total ? m.done / m.total : 0;
    $("#dlbar i").style.width = p * 100 + "%";
    $("#dlbar span").textContent = `${(m.done / 1048576).toFixed(0)} / ${(m.total / 1048576).toFixed(0)} МБ`;
    return;
  }
  const i = STAGES.findIndex(s => s[0] === m.stage);
  $$("#steps div").forEach((d, k) => { d.classList.toggle("on", k === i); d.classList.toggle("done", k < i); });
  const p = m.total ? m.done / m.total : 0;
  $("#wbar i").style.width = p * 100 + "%";
  $("#wbar span").textContent = Math.round(p * 100) + "%";
});

// ── Запись
let rec = null;
$("#copy-consent").addEventListener("click", () => navigator.clipboard.writeText($("#consent-text").textContent));
$("#rec").addEventListener("click", () => (rec ? stopRec() : startRec()));
pk.on("meeting", m => {
  if (rec || busy) return;
  if (m.start) { show("record"); startRec(); return; }
  const b = document.createElement("div");
  b.className = "banner";
  b.innerHTML = `<span>Похоже, началась встреча в ${esc(m.app)}.</span><button class="primary">Записать</button>`;
  b.querySelector("button").onclick = () => { b.remove(); show("record"); startRec(); };
  $("#v-record").prepend(b);
  setTimeout(() => b.remove(), 60000);
});

function meter(stream, el) {
  const ctx = new AudioContext();
  const an = ctx.createAnalyser();
  an.fftSize = 512;
  ctx.createMediaStreamSource(stream).connect(an);
  const buf = new Uint8Array(an.fftSize);
  let alive = true;
  (function tick() { if (!alive) return; an.getByteTimeDomainData(buf); let peak = 0; for (const v of buf) peak = Math.max(peak, Math.abs(v - 128)); el.style.width = Math.min(100, peak * 1.2) + "%"; requestAnimationFrame(tick); })();
  return () => { alive = false; el.style.width = 0; ctx.close(); };
}

async function startRec() {
  const useSys = $("#rec-sys").checked, useMic = $("#rec-mic").checked;
  if (!useSys && !useMic) return alert("Выберите, что записывать");
  const tracks = [], parts = {};
  try {
    if (useSys) {
      const ds = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      const a = ds.getAudioTracks();
      if (!a.length) throw new Error((await pk.platform()) === "darwin" ? "Нет доступа к звуку. Разрешите Протоколисту «Запись экрана и системного звука» в Системных настройках → Конфиденциальность (нужна macOS 14.2+)." : "Не удалось получить звук компьютера");
      tracks.push(...ds.getTracks());
      parts.sys = new MediaStream(a);
    }
    if (useMic) {
      const ms = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      tracks.push(...ms.getTracks());
      parts.mic = ms;
    }
  } catch (e) { tracks.forEach(t => t.stop()); return alert(e.message); }
  const recorders = {}, chunks = {}, stops = [];
  for (const [k, s] of Object.entries(parts)) {
    chunks[k] = [];
    recorders[k] = new MediaRecorder(s, { mimeType: "audio/webm;codecs=opus", audioBitsPerSecond: 64000 });
    recorders[k].ondataavailable = e => e.data.size && chunks[k].push(e.data);
    recorders[k].start(1000);
    stops.push(meter(s, $(k === "mic" ? "#m-mic i" : "#m-sys i")));
  }
  const t0 = Date.now();
  const timer = setInterval(() => ($("#timer").textContent = fmt((Date.now() - t0) / 1000)), 500);
  rec = { recorders, chunks, tracks, stops, timer, t0 };
  $("#rec").textContent = "■ Остановить и расшифровать";
  $("#rec").classList.add("rec");
}

async function stopRec() {
  const r = rec;
  rec = null;
  clearInterval(r.timer);
  r.stops.forEach(f => f());
  await Promise.all(Object.values(r.recorders).map(m => new Promise(res => { m.onstop = res; m.stop(); })));
  r.tracks.forEach(t => t.stop());
  $("#rec").textContent = "● Начать запись";
  $("#rec").classList.remove("rec");
  const stamp = new Date(r.t0).toISOString().slice(0, 16).replace(/[:T]/g, "-");
  const paths = {};
  for (const [k, c] of Object.entries(r.chunks)) paths[k] = await pk.saveRecording(`${stamp}-${k}.webm`, new Uint8Array(await new Blob(c).arrayBuffer()));
  // основной файл — звук встречи; микрофон — отдельной дорожкой «Я». Живая встреча — только микрофон.
  process(paths.sys ?? paths.mic, paths.sys ? paths.mic : undefined);
}

// ── Файл
$("#pick").addEventListener("click", async () => { const f = await pk.pickFile(); if (f) process(f); });
const drop = $("#drop");
drop.addEventListener("dragover", e => { e.preventDefault(); drop.classList.add("over"); });
drop.addEventListener("dragleave", () => drop.classList.remove("over"));
drop.addEventListener("drop", e => { e.preventDefault(); drop.classList.remove("over"); const f = e.dataTransfer.files[0]; if (f) process(pk.pathOf(f)); });

// ── Обработка
async function process(file, micFile) {
  busy = true;
  state.file = file;
  state.micFile = micFile;
  show("work");
  $("#w-title").textContent = "Распознаём речь";
  $("#speakers").hidden = true;
  $("#steps").innerHTML = STAGES.map(s => `<div>${s[1]}</div>`).join("");
  $("#wbar").hidden = false;
  try {
    const tr = await pk.core("transcribe", { file, micFile });
    state.transcript = tr;
    $("#w-title").textContent = `${fmt(tr.duration)} · ${tr.speakers.length} ${tr.speakers.length === 1 ? "участник" : "участника"} · распознано за ${fmt(tr.stats.asrSeconds + tr.stats.diarSeconds)}`;
    $("#wbar").hidden = true;
    $("#sp-list").innerHTML = tr.speakers.map(s => {
      const first = tr.segments.find(x => x.speaker === s.id);
      return `<div class="sp"><span class="mono">${esc(s.label)} · ${fmt(s.talk)}</span><input data-sp="${s.id}" placeholder="${esc(s.id === "me" ? "Я (ваше имя)" : "Имя")}"><q title="${esc(first?.text)}">${esc(first?.text ?? "")}</q></div>`;
    }).join("");
    $("#tpl").value = state.config.template;
    $("#speakers").hidden = false;
  } catch (e) { fail(e); }
}

async function makeProtocol(noProtocol) {
  const names = Object.fromEntries($$("#sp-list input").filter(i => i.value.trim()).map(i => [i.dataset.sp, i.value.trim()]));
  $("#speakers").hidden = true;
  $("#wbar").hidden = false;
  $("#w-title").textContent = noProtocol ? "Сохраняем стенограмму" : "Составляем протокол на этом компьютере";
  try {
    const agenda = $("#agenda").value.split("\n").map(s => s.trim()).filter(Boolean);
    const r = await pk.core("protocol", { transcript: state.transcript, file: state.file, names, template: $("#tpl").value, agenda, keepAudio: $("#keep").checked, noProtocol });
    showResult(r);
  } catch (e) { fail(e); }
}
$("#make").addEventListener("click", () => makeProtocol(false));
$("#only-tr").addEventListener("click", () => makeProtocol(true));

function fail(e) {
  busy = false;
  show("result");
  $("#r-title").textContent = "Не получилось";
  $("#r-summary").textContent = e.message;
  $("#r-stats").innerHTML = $("#r-tasks").innerHTML = "";
  $("#r-note").textContent = "Если ошибка повторяется — сообщите на github.com/kozhevnikovai/protokolist/issues (без записи с личными данными).";
}

function showResult(r) {
  busy = false;
  state.result = r;
  show("result");
  const p = r.protocol;
  $("#r-title").textContent = p?.title ?? "Стенограмма готова";
  $("#r-summary").textContent = p?.summary ?? "";
  const review = p ? p.tasks.filter(t => t.review).length : 0;
  $("#r-stats").innerHTML = p ? `<div>Решений<b>${p.decisions.length}</b></div><div>Задач<b>${p.tasks.length}</b></div><div>Проверить<b>${review}</b></div><div>Модель<b style="font-size:12px">${esc(p.meta.model)}</b></div><div>В сеть<b>${r.netBytes} Б</b></div>` : "";
  $("#r-tasks").innerHTML = p?.tasks.length ? `<table><tr><th>Задача</th><th>Ответственный</th><th>Срок</th></tr>${p.tasks.map(t => `<tr><td>${esc(t.text)}${t.review ? '<div class="review">● проверить по записи</div>' : ""}</td><td>${esc(t.owner || "—")}</td><td class="mono">${t.due ? ruDate(t.due) : esc(t.dueText || "—")}</td></tr>`).join("")}</table>` : "";
  const c = state.config;
  const can = !c.offline && !!p?.tasks.length;
  $("#r-b24").hidden = !(can && c.bitrix24?.webhook);
  $("#r-yg").hidden = !(can && c.yougile?.key);
  $("#r-tg").hidden = !(!c.offline && p && c.telegram?.token);
  $("#r-note").textContent = c.offline && (c.bitrix24?.webhook || c.yougile?.key || c.telegram?.token) ? "Интеграции настроены, но включён строгий офлайн — выключите его в настройках, чтобы отправлять задачи." : "";
}
const htmlFile = () => state.result.files.find(f => f.endsWith(".html")) ?? state.result.dir;
$("#r-open").addEventListener("click", () => pk.open(htmlFile()));
$("#r-folder").addEventListener("click", () => pk.open(state.result.dir));
for (const [id, target] of [["#r-b24", "bitrix24"], ["#r-yg", "yougile"], ["#r-tg", "telegram"]]) $(id).addEventListener("click", async () => {
  $(id).disabled = true;
  try {
    const [res] = await pk.core("send", { dir: state.result.dir, targets: [target] });
    $("#r-note").classList.toggle("err", !!res.failed.length);
    $("#r-note").textContent = `${res.target}: отправлено ${res.ok}${res.failed.length ? `, ошибки: ${res.failed.map(f => f.error).join("; ")}` : ""}`;
  } catch (e) { $("#r-note").textContent = e.message; $("#r-note").classList.add("err"); }
  $(id).disabled = false;
});

// ── Архив
async function loadArchive() {
  const ms = await pk.core("list");
  $("#meetings").innerHTML = ms.length ? `<tr><th>Дата</th><th>Встреча</th><th>Длит.</th><th>Задач</th></tr>${ms.map(m => `<tr data-dir="${esc(m.dir)}"><td class="mono">${ruDate(m.date)}</td><td>${esc(m.title)}</td><td class="mono">${fmt(m.duration)}</td><td class="mono">${m.tasks}</td></tr>`).join("")}` : `<tr><td>Пока нет встреч. Запишите первую.</td></tr>`;
  $$("#meetings tr[data-dir]").forEach(tr => tr.addEventListener("click", () => pk.open(tr.dataset.dir + "/протокол.html")));
}
let qt;
$("#q").addEventListener("input", e => {
  clearTimeout(qt);
  qt = setTimeout(async () => {
    const q = e.target.value.trim();
    if (q.length < 2) return ($("#hits").innerHTML = "");
    const hits = await pk.core("search", { query: q });
    $("#hits").innerHTML = hits.length ? hits.map(h => `<div class="hit" data-id="${esc(h.id)}"><span class="mono">${ruDate(h.date)} · ${esc(h.where)}${h.at !== null ? " · " + fmt(h.at) : ""}</span><br>${esc(h.text)} <span class="mono">— ${esc(h.title)}</span></div>`).join("") : `<p class="note">Ничего не нашлось</p>`;
    $$(".hit").forEach(el => el.addEventListener("click", () => pk.open(state.config.outputDir + "/" + el.dataset.id + "/протокол.html")));
  }, 250);
});

// ── Настройки
const get = (o, k) => k.split(".").reduce((a, x) => a?.[x], o);
function fillSettings() {
  for (const el of $$("[data-k]")) {
    const v = get(state.config, el.dataset.k);
    if (el.type === "checkbox") el.checked = !!v;
    else el.value = Array.isArray(v) ? v.join(",") : v ?? "";
  }
}
$("#pickdir").addEventListener("click", async () => { const d = await pk.pickDir(); if (d) $("#outdir").value = d; });
$("#save").addEventListener("click", async () => {
  const patch = {};
  for (const el of $$("[data-k]")) {
    let v = el.type === "checkbox" ? el.checked : el.type === "number" ? Number(el.value) || 0 : el.value.trim();
    if (el.dataset.k === "formats") v = String(v).split(",").map(s => s.trim()).filter(Boolean);
    const path = el.dataset.k.split(".");
    let cur = patch;
    path.slice(0, -1).forEach(p => (cur = cur[p] ??= {}));
    cur[path.at(-1)] = v;
  }
  for (const k of ["bitrix24", "yougile", "telegram"]) if (patch[k] && !Object.values(patch[k]).some(Boolean)) patch[k] = undefined;
  state.config = await pk.core("saveConfig", { patch });
  $("#saved").textContent = "Сохранено";
  setTimeout(() => ($("#saved").textContent = ""), 2000);
});

init();
