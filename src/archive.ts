// Архив встреч: папки в каталоге протоколов, в каждой — встреча.json. Поиск по всем встречам локально.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Meeting } from "./export/text.js";
import { fmtTime, speakerLabel } from "./transcribe.js";

export interface ArchiveItem { id: string; dir: string; date: string; title: string; tasks: number; duration: number; /** Что открывать: протокол, стенограмма или папка */ file: string }

const mainFile = (dir: string) => ["протокол.html", "стенограмма.html"].map(f => join(dir, f)).find(existsSync) ?? dir;

export function listMeetings(root: string): ArchiveItem[] {
  if (!existsSync(root)) return [];
  return readdirSync(root).map(name => join(root, name)).filter(d => existsSync(join(d, "встреча.json")) && statSync(d).isDirectory()).map(dir => {
    const m = load(dir);
    return { id: dir.split(/[\\/]/).pop()!, dir, date: m.transcript.date, title: m.protocol?.title ?? m.transcript.source, tasks: m.protocol?.tasks.length ?? 0, duration: m.transcript.duration, file: mainFile(dir) };
  }).sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id));
}

export const load = (dir: string): Meeting => JSON.parse(readFileSync(join(dir, "встреча.json"), "utf8"));

export interface Hit { id: string; date: string; title: string; where: string; at: number | null; text: string; file: string }

/** Поиск по словам во всех протоколах и стенограммах: решения и задачи выше реплик */
export function searchMeetings(root: string, query: string, limit = 30): Hit[] {
  const words = query.toLowerCase().replace(/ё/g, "е").split(/\s+/).filter(w => w.length > 1).map(w => (w.length >= 5 ? w.slice(0, w.length > 6 ? -2 : -1) : w));
  const match = (s: string) => { const t = s.toLowerCase().replace(/ё/g, "е"); return words.every(w => t.includes(w)); };
  const hits: Hit[] = [];
  for (const it of listMeetings(root)) {
    const m = load(it.dir);
    const base = { id: it.id, date: it.date, title: it.title, file: it.file };
    for (const d of m.protocol?.decisions ?? []) if (match(d.text)) hits.push({ ...base, where: "решение", at: d.t, text: d.text });
    for (const t of m.protocol?.tasks ?? []) if (match(`${t.text} ${t.owner}`)) hits.push({ ...base, where: "задача", at: t.t, text: `${t.text} — ${t.owner || "?"}${t.due ? `, до ${t.due}` : ""}` });
    for (const s of m.transcript.segments) if (match(s.text)) hits.push({ ...base, where: "стенограмма", at: s.start, text: `${speakerLabel(m.transcript, s.speaker)}: ${s.text}` });
  }
  return hits.slice(0, limit);
}

export const hitLine = (h: Hit) => `${h.date} «${h.title}» · ${h.where}${h.at !== null ? ` [${fmtTime(h.at)}]` : ""}: ${h.text}`;
