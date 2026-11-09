// Фоновый процесс: распознавание и протокол не тормозят окно. Методы вызываются из главного процесса.
import * as core from "../dist/index.js";
import { listMeetings, load, searchMeetings, hitLine } from "../dist/archive.js";

const port = process.parentPort;
const progress = (stage, done, total) => port.postMessage({ type: "progress", stage, done, total });
const net = () => port.postMessage({ type: "net", ...core.netStats() });

let downloading = null;
const methods = {
  status() {
    const c = core.loadConfig();
    return { version: core.VERSION, missing: core.missing().map(f => f.path), packs: core.plan(), left: core.totalSize(core.missing()), downloading: !!downloading, config: c, templates: Object.values(core.TEMPLATES).map(t => ({ id: t.id, title: t.title })), net: core.netStats() };
  },
  async download() {
    if (downloading) return downloading; // повторный клик не запускает вторую загрузку
    downloading = core.download(undefined, e => port.postMessage({ type: "progress", stage: "download", ...e })).then(() => true).finally(() => { downloading = null; });
    return downloading;
  },
  async check({ target, cfg }) {
    if (core.loadConfig().offline) return { ok: false, message: "Включён строгий офлайн — выключите его в «Приватности», чтобы проверить подключение" };
    const fn = { bitrix24: core.checkBitrix24, yougile: core.checkYouGile, telegram: core.checkTelegram }[target];
    return fn ? fn(cfg) : { ok: false, message: "Неизвестный сервис" };
  },
  saveConfig({ patch }) { return core.saveConfig(patch); },
  async transcribe({ file, micFile, speakers }) {
    const c = core.loadConfig();
    const tr = await core.transcribe(file, { micFile, speakers, glossary: core.parseGlossary(c.glossary), onProgress: progress });
    return tr;
  },
  async protocol({ transcript, file, micFile, names, template, agenda, keepAudio, send, noProtocol }) {
    const c = core.loadConfig();
    const r = await core.finish(transcript, file, { config: c, micFile, names, template, agenda, keepAudio, send, noProtocol, onProgress: progress });
    net();
    return { dir: r.dir, files: r.files, sent: r.sent, protocol: r.meeting.protocol, netBytes: r.netBytes };
  },
  async send({ dir, targets }) {
    const c = core.loadConfig();
    const m = load(dir);
    const p = c.maskOnSend ? core.mask(m.protocol) : m.protocol;
    const out = [];
    if (targets.includes("bitrix24") && c.bitrix24?.webhook) out.push(await core.sendToBitrix24(p, c.bitrix24));
    if (targets.includes("yougile") && c.yougile?.key) out.push(await core.sendToYouGile(p, c.yougile));
    if (targets.includes("telegram") && c.telegram?.token) out.push(await core.sendToTelegram(p, c.telegram));
    net();
    return out;
  },
  list() { return listMeetings(core.loadConfig().outputDir); },
  search({ query }) { return searchMeetings(core.loadConfig().outputDir, query).map(h => ({ ...h, line: hitLine(h) })); },
};

port.on("message", async e => {
  const { id, method, args } = e.data;
  try {
    core.setSecrets(e.data.secrets);
    core.setOffline(core.loadConfig().offline);
    port.postMessage({ id, result: await methods[method](args ?? {}) });
  } catch (err) { port.postMessage({ id, error: err?.message ?? String(err) }); }
});
