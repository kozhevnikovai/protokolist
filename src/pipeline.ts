// Полный цикл: аудио → стенограмма → протокол → файлы (+ интеграции по желанию).
import { copyFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { analyze } from "./analytics.js";
import type { Config } from "./config.js";
import { toDocx } from "./export/docx.js";
import { toHtml } from "./export/html.js";
import { type Meeting, toIcs, toMarkdown, toSrt, toTxt } from "./export/text.js";
import { parseGlossary } from "./glossary.js";
import { type SendResult, sendToBitrix24, sendToTelegram, sendToYouGile } from "./integrations/index.js";
import { netStats, setOffline } from "./net.js";
import { mask } from "./privacy.js";
import { buildProtocol } from "./protocol/build.js";
import { createLLM } from "./protocol/llm.js";
import { renameSpeakers, transcribe, type TranscribeOptions } from "./transcribe.js";
import type { Transcript } from "./types.js";

export const FORMATS = ["html", "docx", "md", "json", "txt", "srt", "ics"] as const;

export interface RunOptions extends Omit<TranscribeOptions, "glossary" | "onProgress"> {
  config: Config;
  outDir?: string;
  template?: string;
  agenda?: string[];
  formats?: string[];
  /** Только стенограмма, без протокола */
  noProtocol?: boolean;
  /** Отправить в интеграции: "bitrix24" | "yougile" | "telegram" */
  send?: string[];
  /** Скопировать аудио к протоколу (для проигрывания по тайм-кодам) */
  keepAudio?: boolean;
  onProgress?: (stage: string, done: number, total: number) => void;
}

export interface RunResult { dir: string; files: string[]; meeting: Meeting; sent: SendResult[]; netBytes: number }

const slug = (s: string) => s.replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 60) || "встреча";

export async function run(file: string, o: RunOptions): Promise<RunResult> {
  const c = o.config;
  setOffline(c.offline);
  const tr = await transcribe(file, { ...o, glossary: parseGlossary(c.glossary), onProgress: o.onProgress });
  return finish(tr, file, o);
}

/** Протокол и файлы по готовой стенограмме (например, после переименования спикеров) */
export async function finish(tr: Transcript, audioFile: string | null, o: RunOptions): Promise<RunResult> {
  const c = o.config;
  setOffline(c.offline);
  if (o.names) tr = renameSpeakers(tr, o.names);
  const meeting: Meeting = { transcript: tr, analytics: analyze(tr, c.hourlyRate || undefined) };
  if (!o.noProtocol) {
    const llm = await createLLM(c.llm);
    try {
      meeting.protocol = await buildProtocol(tr, llm, { template: o.template ?? c.template, agenda: o.agenda, onProgress: (d, t) => o.onProgress?.("protocol", d, t) });
    } finally { await llm.dispose(); }
  }
  const title = meeting.protocol?.title ?? basename(tr.source, extname(tr.source));
  const dir = o.outDir ?? join(c.outputDir, `${tr.date} ${slug(title)}`);
  mkdirSync(dir, { recursive: true });
  const files: string[] = [];
  const put = (name: string, data: string | Buffer) => { const p = join(dir, name); writeFileSync(p, data); files.push(p); return p; };

  let audioRel: string | undefined;
  if (audioFile && o.keepAudio && !c.deleteAudio && existsSync(audioFile)) {
    audioRel = "запись" + extname(audioFile);
    copyFileSync(audioFile, join(dir, audioRel));
  }
  const formats = o.formats ?? c.formats;
  const cloudBytes = netStats().requests.filter(r => r.kind === "cloud-llm").reduce((a, r) => a + r.bytes, 0);
  const doc = meeting.protocol ? "протокол" : "стенограмма";
  for (const f of formats) {
    if (f === "html") put(`${doc}.html`, toHtml(meeting, { audio: audioRel, sentBytes: cloudBytes }));
    else if (f === "md") put(`${doc}.md`, toMarkdown(meeting));
    else if (f === "json") put("встреча.json", JSON.stringify(meeting, null, 2));
    else if (f === "txt") put("стенограмма.txt", toTxt(tr));
    else if (f === "srt") put("стенограмма.srt", toSrt(tr));
    else if (f === "docx" && meeting.protocol) put("протокол.docx", await toDocx(meeting, { ...c.gost, withTranscript: true }));
    else if (f === "ics" && meeting.protocol?.tasks.some(t => t.due)) put("сроки.ics", toIcs(meeting.protocol));
  }
  // встреча.json нужна всегда — по ней приложение и MCP-сервер показывают архив
  if (!formats.includes("json")) writeFileSync(join(dir, "встреча.json"), JSON.stringify(meeting, null, 2));

  const sent: SendResult[] = [];
  const p = meeting.protocol;
  if (p && o.send?.length) {
    const out = c.maskOnSend ? mask(p) : p;
    if (o.send.includes("bitrix24") && c.bitrix24?.webhook) sent.push(await sendToBitrix24(out, c.bitrix24));
    if (o.send.includes("yougile") && c.yougile?.key) sent.push(await sendToYouGile(out, c.yougile));
    if (o.send.includes("telegram") && c.telegram?.token) {
      const docx = files.find(f => f.endsWith(".docx"));
      sent.push(await sendToTelegram(out, c.telegram, docx && !c.maskOnSend ? [{ name: basename(docx), data: readFileSync(docx), mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }] : []));
    }
  }
  if (audioFile && c.deleteAudio && existsSync(audioFile)) { try { unlinkSync(audioFile); } catch { /* файл занят — оставим */ } }
  return { dir, files, meeting, sent, netBytes: netStats().sentBytes };
}

