// Текстовые форматы: Markdown-протокол, стенограмма TXT и SRT, календарь .ics с задачами.
import { getTemplate } from "../protocol/templates.js";
import { fmtTime, speakerLabel, transcriptText } from "../transcribe.js";
import type { Analytics, CarriedTask, Protocol, Transcript } from "../types.js";

export interface Meeting {
  transcript: Transcript; protocol?: Protocol; analytics?: Analytics;
  /** Серия встреч: «Планёрка отдела продаж», «1:1 с Анной» */
  series?: string;
  /** Задачи с прошлой встречи серии */
  previous?: { title: string; date: string; tasks: CarriedTask[] };
}

const ruDate = (iso: string) => { const [y, m, d] = iso.split("-"); return `${d}.${m}.${y}`; };
export const CARRY_STATUS = { done: "выполнено", discussed: "обсуждали", open: "не выполнено" } as const;
export const carryTitle = (m: Meeting) => `С прошлой встречи (${ruDate(m.previous!.date)})`;
export const tc = (t: number | null) => (t === null ? "⚠ проверить" : fmtTime(t));

export function toMarkdown(m: Meeting): string {
  const { transcript: tr, protocol: p, analytics: a } = m;
  const L: string[] = [];
  L.push(`# ${p?.title ?? "Стенограмма встречи"}`, "");
  L.push(`**Дата:** ${ruDate(tr.date)}${m.series ? ` · **Серия:** ${m.series}` : ""} · **Длительность:** ${fmtTime(tr.duration)} · **Участники:** ${tr.speakers.map(s => s.label).join(", ")}`, "");
  if (p) {
    if (p.meta.warnings?.length) L.push(...p.meta.warnings.map(w => `> ⚠ ${w}`), "");
    if (p.summary) L.push("## Кратко", "", p.summary, "");
    if (p.decisions.length) {
      L.push("## Решения", "");
      p.decisions.forEach((d, i) => L.push(`${i + 1}. ${d.text} — \`${tc(d.t)}\``));
      L.push("");
    }
    if (p.tasks.length) {
      L.push("## Задачи", "", "| № | Задача | Ответственный | Срок | Тайм-код |", "|---|---|---|---|---|");
      p.tasks.forEach((t, i) => L.push(`| ${i + 1} | ${cell(t.text)}${t.review ? " ⚠" : ""} | ${cell(t.owner || "—")} | ${t.due ? ruDate(t.due) : cell(t.dueText || "—")} | ${tc(t.t)} |`));
      L.push("", "⚠ — пункт стоит проверить по записи: не найдена цитата, ответственный или точный срок.", "");
    }
    const tpl = getTemplate(p.template);
    for (const [k, items] of Object.entries(p.extra)) if (items.length) L.push(`## ${tpl.extraTitles[k] ?? k}`, "", ...items.map(x => `- ${x}`), "");
    if (p.topics.length) {
      L.push("## Ход обсуждения", "");
      for (const t of p.topics) L.push(`### ${t.title}`, t.speakers.length ? `_${t.speakers.join(", ")}_` : "", ...t.points.map(x => `- ${x}`), "");
    }
    if (m.previous?.tasks.length) L.push(`## ${carryTitle(m)}`, "", ...m.previous.tasks.map(t => `- ${t.status === "done" ? "✓" : t.status === "discussed" ? "↻" : "○"} ${t.text}${t.owner ? ` — ${t.owner}` : ""} · ${CARRY_STATUS[t.status]}${t.at !== null ? ` \`${fmtTime(t.at)}\`` : ""}`), "");
    if (p.openQuestions.length) L.push("## Открытые вопросы", "", ...p.openQuestions.map(x => `- ${x}`), "");
    if (p.missedAgenda.length) L.push("## Не обсудили из повестки", "", ...p.missedAgenda.map(x => `- ${x}`), "");
  }
  if (a) {
    L.push("## Аналитика встречи", "", ...a.talkShare.map(s => `- ${s.speaker}: ${s.percent}% (${fmtTime(s.seconds)})`));
    if (a.longestMonologue.seconds) L.push(`- Самый длинный монолог: ${a.longestMonologue.speaker}, ${fmtTime(a.longestMonologue.seconds)}`);
    if (a.cost) L.push(`- Стоимость встречи: ${a.cost.toLocaleString("ru-RU")} ₽`);
    L.push("");
  }
  L.push("## Стенограмма", "", ...tr.segments.map(s => `**[${fmtTime(s.start)}] ${speakerLabel(tr, s.speaker)}:** ${s.text}`), "");
  L.push("---", `_Протоколист · обработано локально${p ? ` · модель ${p.meta.model}` : ""}_`);
  return L.join("\n");
}
const cell = (s: string) => s.replace(/\|/g, "/").replace(/\n/g, " ");

export const toTxt = (tr: Transcript) => transcriptText(tr) + "\n";

export function toSrt(tr: Transcript): string {
  const t = (x: number) => {
    const ms = Math.round(x * 1000), h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60, s = Math.floor(ms / 1000) % 60;
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(ms % 1000).padStart(3, "0")}`;
  };
  return tr.segments.map((s, i) => `${i + 1}\n${t(s.start)} --> ${t(s.end)}\n${speakerLabel(tr, s.speaker)}: ${s.text}\n`).join("\n");
}

/** Календарь: задача со сроком — событие на весь день в день срока, с напоминанием утром */
export function toIcs(p: Protocol): string {
  const esc = (s: string) => s.replace(/[\\;,]/g, c => "\\" + c).replace(/\n/g, "\\n");
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
  const ev = p.tasks.filter(t => t.due).map((t, i) => {
    const d = t.due!.replace(/-/g, "");
    return ["BEGIN:VEVENT", `UID:protokolist-${p.date}-${i}-${d}@kozhevnikovai`, `DTSTAMP:${stamp}`, `DTSTART;VALUE=DATE:${d}`,
      `SUMMARY:${esc(t.text)}`, `DESCRIPTION:${esc(`Ответственный: ${t.owner || "не назван"}\nИз встречи «${p.title}» ${p.date}`)}`,
      "BEGIN:VALARM", "TRIGGER:PT9H", "ACTION:DISPLAY", `DESCRIPTION:${esc(t.text)}`, "END:VALARM", "END:VEVENT"].join("\r\n");
  });
  return ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//kozhevnikovai//Protokolist//RU", "CALSCALE:GREGORIAN", ...ev, "END:VCALENDAR", ""].join("\r\n");
}
