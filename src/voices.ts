// Знакомые голоса: участник, которого один раз подписали, дальше узнаётся сам.
// Хранится только «отпечаток» голоса (вектор CAM++, 192 числа) — не запись. Файл voices.json в папке Протоколиста,
// никуда не отправляется. Включается в настройках: голос — биометрические данные, участники должны быть согласны.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homeDir } from "./models.js";

export interface Voice { name: string; emb: number[]; /** Сколько встреч усреднено */ n: number; updated: string }

/** Порог косинусной близости CAM++: ниже — не узнаём (лучше «Спикер 2», чем чужое имя) */
export const VOICE_THRESHOLD = 0.62;
/** Минимум речи кластера, с, чтобы узнавать и запоминать */
export const VOICE_MIN_TALK = 5;
const MAX_VOICES = 200;

const file = () => join(homeDir(), "voices.json");

export function listVoices(): Voice[] {
  if (!existsSync(file())) return [];
  try { const v = JSON.parse(readFileSync(file(), "utf8")).voices; return Array.isArray(v) ? v.filter(x => x?.name && Array.isArray(x.emb)) : []; }
  catch { return []; }
}
const store = (v: Voice[]) => writeFileSync(file(), JSON.stringify({ version: 1, voices: v.slice(0, MAX_VOICES) }));

const unit = (v: number[]) => { const n = Math.hypot(...v) || 1; return v.map(x => x / n); };
export const cosine = (a: number[], b: number[]) => { let s = 0; for (let i = 0; i < Math.min(a.length, b.length); i++) s += a[i] * b[i]; return s; };

/** Узнать голоса: { s1: "Иван Петров" }. Каждое имя — не больше одному спикеру, лучшие пары первыми. */
export function matchVoices(centroids: Record<string, number[]>, voices = listVoices(), threshold = VOICE_THRESHOLD): Record<string, string> {
  const pairs: { id: string; name: string; s: number }[] = [];
  for (const [id, c] of Object.entries(centroids)) for (const v of voices) {
    if (v.emb.length !== c.length) continue;
    const s = cosine(c, v.emb);
    if (s >= threshold) pairs.push({ id, name: v.name, s });
  }
  pairs.sort((a, b) => b.s - a.s);
  const out: Record<string, string> = {}, used = new Set<string>();
  for (const p of pairs) if (!out[p.id] && !used.has(p.name)) { out[p.id] = p.name; used.add(p.name); }
  return out;
}

const normName = (s: string) => s.trim().replace(/\s+/g, " ").slice(0, 60);
const generic = (s: string) => /^(я|спикер\s*\d+|speaker\s*\d+|участник\s*\d*|\?|—|-)$/i.test(s);

/** Запомнить подписанных участников: скользящее среднее отпечатка, не больше 20 встреч веса */
export function learnVoices(centroids: Record<string, number[]>, names: Record<string, string>): string[] {
  const voices = listVoices();
  const learned: string[] = [];
  for (const [id, raw] of Object.entries(names)) {
    const name = normName(raw ?? "");
    const c = centroids[id];
    if (!c || id === "me" || !name || generic(name)) continue;
    const v = voices.find(x => x.name.toLowerCase() === name.toLowerCase());
    if (v && v.emb.length === c.length) {
      const w = Math.min(v.n, 20);
      v.emb = round(unit(v.emb.map((x, i) => (x * w + c[i]) / (w + 1))));
      v.n++; v.updated = new Date().toISOString().slice(0, 10);
    } else if (!v) voices.unshift({ name, emb: round(unit(c)), n: 1, updated: new Date().toISOString().slice(0, 10) });
    learned.push(name);
  }
  if (learned.length) store(voices);
  return learned;
}

export function forgetVoice(name: string): boolean {
  const voices = listVoices();
  const left = voices.filter(v => v.name !== name);
  if (left.length === voices.length) return false;
  store(left);
  return true;
}
export function forgetAllVoices() { store([]); }

const round = (v: number[]) => v.map(x => Math.round(x * 1e4) / 1e4);

/** Средний отпечаток каждого спикера, взвешенный по длительности фраз */
export function centroidsOf(pieces: { speaker?: string; emb?: number[]; start: number; end: number }[], minTalk = VOICE_MIN_TALK): Record<string, number[]> {
  const acc = new Map<string, { v: number[]; talk: number }>();
  for (const p of pieces) {
    if (!p.emb || !p.speaker || p.speaker === "me") continue;
    const w = p.end - p.start;
    const a = acc.get(p.speaker) ?? { v: new Array(p.emb.length).fill(0), talk: 0 };
    p.emb.forEach((x, i) => (a.v[i] += x * w));
    a.talk += w;
    acc.set(p.speaker, a);
  }
  return Object.fromEntries([...acc].filter(([, a]) => a.talk >= minTalk).map(([id, a]) => [id, round(unit(a.v))]));
}
