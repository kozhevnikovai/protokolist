// Фоновый процесс: распознавание и протокол не тормозят окно. Методы вызываются из главного процесса.
import * as core from "../dist/index.js";
import { listMeetings, load, searchMeetings, hitLine } from "../dist/archive.js";

const port = process.parentPort;
const progress = (stage, done, total) => port.postMessage({ type: "progress", stage, done, total });
const net = () => port.postMessage({ type: "net", ...core.netStats() });

const methods = {
  status() {
    const c = core.loadConfig();
    return { version: core.VERSION, missing: core.missing().map(f => f.path), packs: Object.values(core.PACKS).map(p => ({ id: p.id, title: p.title, license: p.license })), config: c, templates: Object.values(core.TEMPLATES).map(t => ({ id: t.id, title: t.title })), net: core.netStats() };
  },
  async download() { await core.download(undefined, e => progress("download", e.done, e.total)); return true; },
  saveConfig({ patch }) { return core.saveConfig(patch); },
  async transcribe({ file, micFile, speakers }) {
    const c = core.loadConfig();
    const tr = await core.transcribe(file, { micFile, speakers, glossary: core.parseGlossary(c.glossary), onProgress: progress });
    return tr;
  },
  async protocol({ transcript, file, names, template, agenda, keepAudio, send, noProtocol }) {
    const c = core.loadConfig();
    const r = await core.finish(transcript, file, { config: c, names, template, agenda, keepAudio, send, noProtocol, onProgress: progress });
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
    core.setOffline(core.loadConfig().offline);
    port.postMessage({ id, result: await methods[method](args ?? {}) });
  } catch (err) { port.postMessage({ id, error: err?.message ?? String(err) }); }
});
