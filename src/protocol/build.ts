// Протокол из стенограммы: модель извлекает пункты по частям встречи, код проверяет цитаты, сроки и дубли.
import { fmtTime, speakerLabel } from "../transcribe.js";
import type { Decision, Protocol, Task, Topic, Transcript } from "../types.js";
import { parseDue } from "./dates.js";
import type { LLM } from "./llm.js";
import { getTemplate, type Template } from "./templates.js";

export interface ProtocolOptions {
  template?: string;
  /** Повестка: по пункту на строку */
  agenda?: string[];
  /** Символов стенограммы на один запрос к модели */
  chunkChars?: number;
  onProgress?: (done: number, total: number) => void;
}

const str = { type: "string" } as const;
const arr = (items: object) => ({ type: "array", items });

function chunkSchema(t: Template) {
  const keys = Object.keys(t.extra);
  const props: Record<string, object> = {
    topics: arr({ type: "object", properties: { title: str, speakers: arr(str), points: arr(str) } }),
    decisions: arr({ type: "object", properties: { text: str, topic: str, quote: str } }),
    tasks: arr({ type: "object", properties: { text: str, owner: str, due: str, quote: str } }),
    openQuestions: arr(str),
  };
  if (keys.length) props.extra = { type: "object", properties: Object.fromEntries(keys.map(k => [k, arr(str)])) };
  return { type: "object", properties: props };
}
const finalSchema = { type: "object", properties: { title: str, summary: str, missedAgenda: arr(str) } };

function system(t: Template, participants: string[]) {
  const extra = Object.entries(t.extra).map(([k, v]) => `- extra.${k}: ${v}`).join("\n");
  return `Ты — опытный секретарь совещаний. Составляешь протокол встречи по стенограмме на русском языке.
${t.focus}

Участники (как подписаны в стенограмме): ${participants.join(", ")}.

Правила:
1. Только то, что прозвучало во встрече. Ничего не придумывай: ни задач, ни ответственных, ни сроков, ни цифр.
2. Решение — то, о чём договорились. Задача — конкретное действие конкретного человека. Пустые обсуждения без итога не включай.
3. quote — дословный фрагмент стенограммы из 5–15 слов, который подтверждает пункт. Копируй слова как есть.
4. owner — ответственный: имя, названное в речи («Иван, подготовь…»), или подпись спикера, который взял задачу на себя. Если неясно — пустая строка.
5. due — срок так, как его сказали («до пятницы», «15 ноября»). Если срок не назван — пустая строка.
6. topics — темы обсуждения: короткое название, кто говорил по теме, 1–4 главных тезиса.
7. openQuestions — вопросы, которые остались без ответа или отложены.
${extra}
8. Пиши кратко и по-деловому. Тайм-коды в квадратных скобках не переписывай.`;
}

/** Делим стенограмму по репликам на куски, с перекрытием в 2 реплики, чтобы не терять контекст на стыках */
export function chunkTranscript(lines: string[], maxChars: number): string[] {
  const out: string[] = [];
  let cur: string[] = [];
  let len = 0;
  for (const l of lines) {
    if (len + l.length > maxChars && cur.length) {
      out.push(cur.join("\n"));
      cur = cur.slice(-2);
      len = cur.reduce((a, x) => a + x.length + 1, 0);
    }
    cur.push(l);
    len += l.length + 1;
  }
  if (cur.length) out.push(cur.join("\n"));
  return out;
}

const normWords = (s: string) => s.toLowerCase().replace(/ё/g, "е").replace(/[^\p{L}\d ]/gu, " ").split(/\s+/).filter(Boolean);

/** Ищем цитату в стенограмме: реплика с наибольшей долей слов цитаты. Не нашли (меньше 60%) — пункт требует проверки. */
export function locateQuote(t: Transcript, quote: string): number | null {
  const q = normWords(quote);
  if (q.length < 2) return null;
  let best = 0, at: number | null = null;
  for (const s of t.segments) {
    const w = new Set(normWords(s.text));
    const hit = q.filter(x => w.has(x)).length / q.length;
    if (hit > best) { best = hit; at = s.start; }
  }
  return best >= 0.6 ? at : null;
}

function overlap(a: string, b: string) {
  const A = new Set(normWords(a)), B = normWords(b);
  if (!A.size || !B.length) return 0;
  return B.filter(x => A.has(x)).length / Math.max(A.size, B.length);
}
function dedupe<T extends { text: string }>(items: T[]): T[] {
  const out: T[] = [];
  for (const x of items) if (!out.some(y => overlap(y.text, x.text) > 0.7)) out.push(x);
  return out;
}

interface Chunk { topics: Topic[]; decisions: { text: string; topic: string; quote: string }[]; tasks: { text: string; owner: string; due: string; quote: string }[]; openQuestions: string[]; extra?: Record<string, string[]> }

export async function buildProtocol(tr: Transcript, llm: LLM, o: ProtocolOptions = {}): Promise<Protocol> {
  const t0 = Date.now();
  const tpl = getTemplate(o.template);
  const participants = tr.speakers.map(s => s.label);
  const lines = tr.segments.map(s => `[${fmtTime(s.start)}] ${speakerLabel(tr, s.speaker)}: ${s.text}`);
  const chunks = chunkTranscript(lines, o.chunkChars ?? 9000);
  const sys = system(tpl, participants);
  const schema = chunkSchema(tpl);
  const parts: Chunk[] = [];
  for (let i = 0; i < chunks.length; i++) {
    o.onProgress?.(i, chunks.length + 1);
    const head = chunks.length > 1 ? `Это часть ${i + 1} из ${chunks.length} встречи.\n\n` : "";
    parts.push(await llm.json<Chunk>(sys, `${head}Стенограмма:\n${chunks[i]}`, schema));
  }
  o.onProgress?.(chunks.length, chunks.length + 1);

  const topics = mergeTopics(parts.flatMap(p => p.topics ?? []));
  const decisions: Decision[] = dedupe(parts.flatMap(p => p.decisions ?? []).filter(d => d.text?.trim()))
    .map(d => ({ text: d.text.trim(), topic: d.topic?.trim() || undefined, quote: d.quote ?? "", t: locateQuote(tr, d.quote ?? "") }));
  const tasks: Task[] = dedupe(parts.flatMap(p => p.tasks ?? []).filter(x => x.text?.trim())).map(x => {
    const t = locateQuote(tr, x.quote ?? "");
    const due = parseDue(x.due ?? "", tr.date);
    return { text: x.text.trim(), owner: (x.owner ?? "").trim(), dueText: (x.due ?? "").trim(), due, quote: x.quote ?? "", t, review: t === null || !x.owner?.trim() || (!!x.due?.trim() && !due) };
  });
  const extra: Record<string, string[]> = {};
  for (const k of Object.keys(tpl.extra)) extra[k] = uniq(parts.flatMap(p => p.extra?.[k] ?? []));
  const openQuestions = uniq(parts.flatMap(p => p.openQuestions ?? []));

  const digest = [
    `Темы: ${topics.map(x => `${x.title} — ${x.points.join("; ")}`).join(" | ")}`,
    `Решения: ${decisions.map(d => d.text).join("; ")}`,
    `Задачи: ${tasks.map(x => `${x.text} (${x.owner || "ответственный не назван"})`).join("; ")}`,
    o.agenda?.length ? `Повестка: ${o.agenda.join("; ")}` : "",
  ].filter(Boolean).join("\n");
  const fin = await llm.json<{ title: string; summary: string; missedAgenda: string[] }>(
    "Ты — секретарь совещаний. По итогам встречи дай короткое название (до 8 слов), резюме из 2–4 предложений по-деловому" +
      (o.agenda?.length ? " и список пунктов повестки, которые на встрече не обсуждались (если все обсудили — пустой список)." : ". missedAgenda — пустой список."),
    digest, finalSchema, 600);
  o.onProgress?.(chunks.length + 1, chunks.length + 1);

  return {
    title: fin.title?.trim() || "Встреча",
    date: tr.date, template: tpl.id, participants,
    summary: fin.summary?.trim() ?? "",
    topics, decisions, tasks, openQuestions,
    missedAgenda: o.agenda?.length ? (fin.missedAgenda ?? []) : [],
    extra,
    meta: { model: llm.name, seconds: Math.round((Date.now() - t0) / 1000), generatedAt: new Date().toISOString() },
  };
}

const uniq = (xs: string[]) => dedupe(xs.filter(s => s?.trim()).map(text => ({ text: text.trim() }))).map(x => x.text);

function mergeTopics(ts: Topic[]): Topic[] {
  const out: Topic[] = [];
  for (const t of ts) {
    if (!t.title?.trim()) continue;
    const same = out.find(o => overlap(o.title, t.title) > 0.6);
    if (same) { same.points = uniq([...same.points, ...(t.points ?? [])]); same.speakers = [...new Set([...same.speakers, ...(t.speakers ?? [])])]; }
    else out.push({ title: t.title.trim(), speakers: [...new Set(t.speakers ?? [])], points: uniq(t.points ?? []) });
  }
  return out;
}
