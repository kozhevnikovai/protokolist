// Архив встреч: папки в каталоге протоколов, в каждой — встреча.json. Поиск по всем встречам локально.
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join, relative, isAbsolute } from "node:path";
import type { Meeting } from "./export/text.js";
import { fmtTime, speakerLabel } from "./transcribe.js";

export interface ArchiveItem { id: string; dir: string; date: string; title: string; series?: string; tasks: number; duration: number; /** Что открывать: протокол, стенограмма или папка */ file: string }

const mainFile = (dir: string) => ["протокол.html", "стенограмма.html"].map(f => join(dir, f)).find(existsSync) ?? dir;

/** Папки встреч: только настоящие папки внутри архива — без символических ссылок и junction */
function meetingDirs(root: string): string[] {
  if (!existsSync(root)) return [];
  const realRoot = realpathSync(root);
  return readdirSync(root).map(name => join(root, name)).filter(d => {
    try {
      const st = lstatSync(d);
      if (!st.isDirectory() || st.isSymbolicLink() || !existsSync(join(d, "встреча.json"))) return false;
      const r = relative(realRoot, realpathSync(d));
      return !!r && !r.startsWith("..") && !isAbsolute(r);
    } catch { return false; }
  });
}

/** Папки, где встреча.json повреждён: они пропускаются, остальной архив работает */
export function brokenMeetings(root: string): string[] {
  return meetingDirs(root).filter(d => { try { load(d); return false; } catch { return true; } }).map(d => d.split(/[\\/]/).pop()!);
}

export function listMeetings(root: string): ArchiveItem[] {
  const out: ArchiveItem[] = [];
  for (const dir of meetingDirs(root)) {
    let m: Meeting;
    try { m = load(dir); if (!m?.transcript) throw new Error("нет стенограммы"); } catch { continue; /* повреждённая встреча не ломает архив — см. brokenMeetings */ }
    out.push({ id: dir.split(/[\\/]/).pop()!, dir, date: m.transcript.date, title: m.protocol?.title ?? m.transcript.source, ...(m.series ? { series: m.series } : {}), tasks: m.protocol?.tasks.length ?? 0, duration: m.transcript.duration ?? 0, file: mainFile(dir) });
  }
  return out.sort((a, b) => String(b.date).localeCompare(String(a.date)) || b.id.localeCompare(a.id));
}

export const load = (dir: string): Meeting => JSON.parse(readFileSync(join(dir, "встреча.json"), "utf8"));

export interface Hit { id: string; date: string; title: string; where: string; at: number | null; text: string; file: string }

/** Поиск по словам во всех протоколах и стенограммах: решения и задачи выше реплик */
export interface TaskItem { text: string; owner: string; due: string | null; dueText: string | null; review: boolean; done: boolean; meeting: string; series?: string; id: string; index: number; date: string; file: string }

/** Все задачи из протоколов — сводная вкладка «Задачи»: сначала с ближайшим сроком */
export function listTasks(root: string): TaskItem[] {
  const out: TaskItem[] = [];
  for (const m of listMeetings(root)) {
    let tasks: any[] = [];
    try { tasks = load(m.dir).protocol?.tasks ?? []; } catch { continue; }
    tasks.forEach((t, index) => out.push({ text: t.text, owner: t.owner ?? "", due: t.due ?? null, dueText: t.dueText ?? null, review: !!t.review, done: !!t.done, meeting: m.title, ...(m.series ? { series: m.series } : {}), id: m.id, index, date: m.date, file: m.file }));
  }
  return out.sort((a, b) => Number(a.done) - Number(b.done) || (a.due ?? "9999").localeCompare(b.due ?? "9999") || b.date.localeCompare(a.date));
}

export function searchMeetings(root: string, query: string, limit = 30): Hit[] {
  const words = query.toLowerCase().replace(/ё/g, "е").split(/\s+/).filter(w => w.length > 1).map(w => (w.length >= 5 ? w.slice(0, w.length > 6 ? -2 : -1) : w));
  const match = (s: string) => { const t = s.toLowerCase().replace(/ё/g, "е"); return words.every(w => t.includes(w)); };
  const hits: Hit[] = [];
  for (const it of listMeetings(root)) {
    let m: Meeting;
    try { m = load(it.dir); } catch { continue; }
    const base = { id: it.id, date: it.date, title: it.title, file: it.file };
    for (const d of m.protocol?.decisions ?? []) if (match(d.text)) hits.push({ ...base, where: "решение", at: d.t, text: d.text });
    for (const t of m.protocol?.tasks ?? []) if (match(`${t.text} ${t.owner}`)) hits.push({ ...base, where: "задача", at: t.t, text: `${t.text} — ${t.owner || "?"}${t.due ? `, до ${t.due}` : ""}` });
    for (const s of m.transcript.segments) if (match(s.text)) hits.push({ ...base, where: "стенограмма", at: s.start, text: `${speakerLabel(m.transcript, s.speaker)}: ${s.text}` });
  }
  return hits.slice(0, limit);
}

export const hitLine = (h: Hit) => `${h.date} «${h.title}» · ${h.where}${h.at !== null ? ` [${fmtTime(h.at)}]` : ""}: ${h.text}`;
