// Серии встреч: планёрки и 1:1 связываются в цепочку. В протоколе новой встречи — задачи с прошлой и их статус.
// Всё локально, по архиву в папке протоколов.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { listMeetings, load } from "./archive.js";
import type { Meeting } from "./export/text.js";
import type { CarriedTask, Transcript } from "./types.js";

const STOP = new Set("будет нужно надо чтобы этого этому которые который после перед через сделать сделаем подготовить подготовит отправить отправит".split(" "));
const stems = (s: string) => [...new Set(s.toLowerCase().replace(/ё/g, "е").replace(/[^\p{L}\d ]/gu, " ").split(/\s+/)
  .filter(w => w.length > 3 && !STOP.has(w)).map(w => w.slice(0, Math.max(4, Math.ceil(w.length * 0.6)))))];

/** Тайм-код, где задачу обсуждали: большинство значимых слов задачи — в одной реплике или двух соседних */
export function findMention(task: string, tr: Transcript): number | null {
  const key = stems(task);
  if (key.length < 2) return null;
  const need = Math.max(2, Math.ceil(key.length * 0.6));
  const seg = tr.segments;
  const hit = (s: string) => { const t = s.toLowerCase().replace(/ё/g, "е"); return key.filter(k => t.includes(k)).length >= need; };
  // сначала одна реплика, потом пара соседних — тайм-код точнее
  for (const s of seg) if (hit(s.text)) return s.start;
  for (let i = 0; i + 1 < seg.length; i++) if (hit(seg[i].text + " " + seg[i + 1].text)) return seg[i].start;
  return null;
}

export const normSeries = (s?: string) => (s ?? "").replace(/[\u0000-\u001f]/g, "").replace(/\s+/g, " ").trim().slice(0, 80);

/** Все серии в архиве — для подсказки в поле «Серия» */
export function listSeries(root: string): string[] {
  const seen = new Map<string, string>();
  for (const m of listMeetings(root)) if (m.series && !seen.has(m.series.toLowerCase())) seen.set(m.series.toLowerCase(), m.series);
  return [...seen.values()];
}

/** Прошлая встреча той же серии (не позже даты новой) */
export function previousMeeting(root: string, series: string, date: string, exceptDir?: string): { dir: string; meeting: Meeting } | null {
  const s = normSeries(series).toLowerCase();
  if (!s) return null;
  const it = listMeetings(root).find(m => m.series?.toLowerCase() === s && m.date <= date && m.dir !== exceptDir);
  if (!it) return null;
  try { return { dir: it.dir, meeting: load(it.dir) }; } catch { return null; }
}

/** Задачи с прошлой встречи: её собственные + невыполненные, что тянулись к ней раньше */
export function carryOver(prev: Meeting, tr: Transcript): CarriedTask[] {
  const own = (prev.protocol?.tasks ?? []).map(t => ({ text: t.text, owner: t.owner ?? "", due: t.due ?? null, done: !!t.done, from: prev.transcript.date }));
  const older = (prev.previous?.tasks ?? []).filter(t => t.status !== "done").map(t => ({ text: t.text, owner: t.owner, due: t.due, done: false, from: t.from }));
  const seen = new Set<string>();
  return [...older, ...own].filter(t => { const k = t.text.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 100).map(t => {
    const at = t.done ? null : findMention(t.text, tr);
    return { text: t.text, owner: t.owner, due: t.due, from: t.from, status: t.done ? "done" : at !== null ? "discussed" : "open", at };
  });
}

/** Отметить задачу выполненной — только встречи из папки протоколов */
export function setTaskDone(root: string, id: string, index: number, done: boolean): boolean {
  const it = listMeetings(root).find(m => m.id === id);
  if (!it) throw new Error("Встреча не найдена в папке протоколов");
  const m = load(it.dir);
  const t = m.protocol?.tasks[index];
  if (!t) throw new Error("Задача не найдена");
  if (done) t.done = true; else delete t.done;
  writeFileSync(join(it.dir, "встреча.json"), JSON.stringify(m, null, 2));
  return true;
}
