// Фоновый процесс: распознавание и протокол не тормозят окно. Методы вызываются из главного процесса.
import * as core from "../dist/index.js";
import { listMeetings, listTasks, load, searchMeetings, hitLine } from "../dist/archive.js";

const port = process.parentPort;
const progress = (stage, done, total) => port.postMessage({ type: "progress", stage, done, total });
const net = () => port.postMessage({ type: "net", ...core.netStats() });

let downloading = null;
// живые субтитры: по распознавателю на источник звука; модель для пересказа и вопросов держим загруженной
let live = null;
let llm = null;
let llmBusy = null;
async function getLlm() {
  if (llm) return llm;
  llmBusy ??= core.createLLM(core.loadConfig().llm).then(m => (llm = m)).finally(() => { llmBusy = null; });
  return llmBusy;
}
async function freeLlm() { const m = llm; llm = null; await m?.dispose().catch(() => {}); }
const stops = new Map();
let hw = null; // характеристики компьютера: llama.cpp определяет видеокарту один раз
async function models(c) {
  hw ??= await core.detectHardware();
  const r = core.recommend(hw);
  if (!c.llm.localModel) { core.saveConfig({ llm: { localModel: r.model.id } }); c = core.loadConfig(); }
  return { selected: core.selectLlm(c.llm.localModel), recommended: r.model.id, reason: r.reason, hw,
    options: r.options.map(o => ({ id: o.model.id, tier: o.model.tier, title: o.model.title, vendor: o.model.vendor, note: o.model.note, size: o.model.file.size, ok: o.ok, why: o.why })) };
}
const methods = {
  async status() {
    let c = core.loadConfig();
    const llm = await models(c);
    c = core.loadConfig();
    return { llm, version: core.VERSION, missing: core.missing().map(f => f.path), packs: core.plan(), left: core.totalSize(core.missing()), downloading: !!downloading, config: c, templates: Object.values(core.TEMPLATES).map(t => ({ id: t.id, title: t.title })), net: core.netStats() };
  },
  async download() {
    if (downloading) return downloading; // повторный клик не запускает вторую загрузку
    downloading = core.download(undefined, e => port.postMessage({ type: "progress", stage: "download", ...e })).then(() => true).finally(() => { downloading = null; });
    return downloading;
  },
  async check({ target, cfg }) {
    if (target !== "obsidian" && core.loadConfig().offline) return { ok: false, message: "Включён строгий офлайн — выключите его в «Приватности», чтобы проверить подключение" };
    const fn = { bitrix24: core.checkBitrix24, yougile: core.checkYouGile, telegram: core.checkTelegram, kaiten: core.checkKaiten, tracker: core.checkTracker, pachca: core.checkPachca, obsidian: core.checkObsidian }[target];
    return fn ? fn(cfg) : { ok: false, message: "Неизвестный сервис" };
  },
  saveConfig({ patch }) { return core.saveConfig(patch); },
  /** Сменить локальную языковую модель; файлы другой модели не удаляются */
  async setModel({ id }) {
    if (downloading) throw new Error("Дождитесь окончания загрузки");
    if (!core.LLM_MODELS.some(m => m.id === id)) throw new Error("Неизвестная модель");
    core.saveConfig({ llm: { localModel: id } });
    return methods.status();
  },
  async transcribe({ file, micFile, speakers }) {
    const c = core.loadConfig();
    const tr = await core.transcribe(file, { micFile, speakers, glossary: core.parseGlossary(c.glossary), voices: c.voices ? core.listVoices() : undefined, onProgress: progress });
    return tr;
  },
  async protocol({ transcript, file, micFile, names, template, agenda, keepAudio, send, noProtocol, series }) {
    const c = core.loadConfig();
    const r = await core.finish(transcript, file, { config: c, micFile, names, template, agenda, keepAudio, send, noProtocol, series, onProgress: progress });
    net();
    return { dir: r.dir, files: r.files, sent: r.sent, protocol: r.meeting.protocol, previous: r.meeting.previous, series: r.meeting.series, netBytes: r.netBytes };
  },
  async send({ dir, targets }) {
    const c = core.loadConfig();
    const known = listMeetings(c.outputDir).find(m => m.dir === dir);
    if (!known) throw new Error("Встреча не найдена в папке протоколов");
    const out = await core.deliver(load(dir), [], targets, c);
    net();
    return out;
  },
  series() { return core.listSeries(core.loadConfig().outputDir); },
  taskDone({ id, index, done }) { return core.setTaskDone(core.loadConfig().outputDir, id, index, !!done); },
  voices() { return core.listVoices().map(v => ({ name: v.name, n: v.n, updated: v.updated })); },
  forgetVoice({ name }) { return core.forgetVoice(name); },
  forgetAllVoices() { core.forgetAllVoices(); return true; },
  list() { return listMeetings(core.loadConfig().outputDir); },
  tasks() { return listTasks(core.loadConfig().outputDir); },
  liveStart() {
    const c = core.loadConfig();
    const lines = [];
    const glossary = core.parseGlossary(c.glossary);
    const onLine = l => { lines.push(l); port.postMessage({ type: "live", line: l }); };
    live = { lines, me: new core.LiveTranscriber({ source: "me", glossary, onLine }), others: new core.LiveTranscriber({ source: "others", glossary, onLine }) };
    return true;
  },
  livePush({ source, pcm }) {
    if (!live || !(source in { me: 1, others: 1 })) return false;
    const a = pcm instanceof Float32Array ? pcm : new Float32Array(pcm);
    live[source].push(a.subarray(0, 16000 * 10)); // не больше 10 с за раз
    return true;
  },
  liveStop() {
    if (!live) return [];
    const l = live; live = null;
    l.me.finish(); l.others.finish();
    freeLlm();
    return l.lines;
  },
  async catchUp({ minutes, key }) {
    if (!live) throw new Error("Пересказ работает во время записи с субтитрами");
    const ac = new AbortController(); stops.set(key, ac);
    try {
      const m = await getLlm();
      return await core.catchUp(live.lines, m, { minutes: Math.min(30, Math.max(1, Number(minutes) || 5)), signal: ac.signal, onText: t => port.postMessage({ type: "live-text", key, text: t }) });
    } finally { stops.delete(key); }
  },
  async ask({ question, key }) {
    const q = String(question ?? "").trim().slice(0, 500);
    if (q.length < 2) throw new Error("Задайте вопрос");
    const c = core.loadConfig();
    const ac = new AbortController(); stops.set(key, ac);
    try {
      const found = core.retrieve(core.passages(c.outputDir), q, 10);
      const m = found.length && !core.missing(["llm"]).length ? await getLlm() : null;
      const r = await core.askArchive(c.outputDir, q, m, { signal: ac.signal });
      if (!live) freeLlm(); // вне записи модель не держим — освобождаем память
      return r;
    } finally { stops.delete(key); }
  },
  stop({ key }) { stops.get(key)?.abort(); return true; },
  search({ query }) { return searchMeetings(core.loadConfig().outputDir, query).map(h => ({ ...h, line: hitLine(h) })); },
};

port.on("message", async e => {
  // звук для субтитров — поток без ответа, отдельно от вызовов методов
  if (e.data?.type === "pcm") { try { methods.livePush(e.data); } catch { /* фраза не распознана — субтитры не важнее записи */ } return; }
  const { id, method, args } = e.data;
  try {
    core.setSecrets(e.data.secrets);
    core.setOffline(core.loadConfig().offline);
    port.postMessage({ id, result: await methods[method](args ?? {}) });
  } catch (err) { port.postMessage({ id, error: err?.message ?? String(err) }); }
});
