// DOCX: деловой протокол (Arial) или официальный протокол по ГОСТ Р 7.0.97-2016 (Times New Roman 14).
import { AlignmentType, BorderStyle, Document, Packer, Paragraph, Table, TableCell, TableRow, TextRun, WidthType } from "docx";
import { getTemplate } from "../protocol/templates.js";
import { fmtTime, speakerLabel } from "../transcribe.js";
import type { Protocol } from "../types.js";
import { CARRY_STATUS, carryTitle, type Meeting, tc } from "./text.js";

const ruDate = (iso: string) => { const [y, m, d] = iso.split("-"); return `${d}.${m}.${y}`; };

export interface DocxOptions {
  /** Для ГОСТ: реквизиты, которые нельзя узнать из записи */
  organization?: string;
  place?: string;
  number?: string;
  chair?: string;
  secretary?: string;
  /** Добавить стенограмму в приложение */
  withTranscript?: boolean;
}

export async function toDocx(m: Meeting, o: DocxOptions = {}): Promise<Buffer> {
  if (!m.protocol) throw new Error("Для DOCX нужен протокол");
  const doc = m.protocol.template === "gost" ? gost(m, m.protocol, o) : business(m, m.protocol, o);
  return Packer.toBuffer(doc);
}

const P = (text: string, opt: { bold?: boolean; size?: number; align?: (typeof AlignmentType)[keyof typeof AlignmentType]; after?: number; caps?: boolean; color?: string } = {}) =>
  new Paragraph({ alignment: opt.align, spacing: { after: opt.after ?? 120 }, children: [new TextRun({ text, bold: opt.bold, size: opt.size, allCaps: opt.caps, color: opt.color })] });

function table(head: string[], rows: string[][], widths: number[]) {
  const border = { style: BorderStyle.SINGLE, size: 4, color: "161616" };
  const borders = { top: border, bottom: border, left: border, right: border };
  const row = (cells: string[], bold = false) => new TableRow({
    children: cells.map((c, i) => new TableCell({ borders, width: { size: widths[i], type: WidthType.PERCENTAGE }, children: [new Paragraph({ children: [new TextRun({ text: c, bold })] })] })),
  });
  return new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: [row(head, true), ...rows.map(r => row(r))] });
}

function tasksTable(p: Protocol) {
  return table(["№", "Задача", "Ответственный", "Срок", "Тайм-код"],
    p.tasks.map((t, i) => [String(i + 1), t.text + (t.review ? " ⚠" : ""), t.owner || "—", t.due ? ruDate(t.due) : t.dueText || "—", tc(t.t)]), [6, 50, 20, 12, 12]);
}

function transcript(m: Meeting): Paragraph[] {
  const tr = m.transcript;
  return [P("Приложение. Стенограмма", { bold: true, after: 200 }),
    ...tr.segments.map(s => new Paragraph({ spacing: { after: 80 }, children: [new TextRun({ text: `[${fmtTime(s.start)}] ${speakerLabel(tr, s.speaker)}: `, bold: true }), new TextRun(s.text)] }))];
}

function business(m: Meeting, p: Protocol, o: DocxOptions) {
  const tr = m.transcript;
  const tpl = getTemplate(p.template);
  const H = (t: string) => P(t, { bold: true, size: 26, after: 160 });
  const list = (xs: string[]) => xs.map(x => new Paragraph({ bullet: { level: 0 }, spacing: { after: 60 }, children: [new TextRun(x)] }));
  const body: (Paragraph | Table)[] = [
    P("ПРОТОКОЛ ВСТРЕЧИ", { bold: true, size: 20, color: "5C5C5C" }),
    P(p.title, { bold: true, size: 36, after: 200 }),
    P(`Дата: ${ruDate(p.date)}   Длительность: ${fmtTime(tr.duration)}   Участники: ${p.participants.join(", ")}`, { size: 20, color: "5C5C5C", after: 300 }),
  ];
  if (p.summary) body.push(H("Кратко"), P(p.summary));
  if (p.decisions.length) body.push(H("Решения"), ...p.decisions.map((d, i) => P(`${i + 1}. ${d.text}  [${tc(d.t)}]`)));
  if (p.tasks.length) body.push(H("Задачи"), tasksTable(p), P("⚠ — проверить по записи.", { size: 18, color: "5C5C5C" }));
  for (const [k, items] of Object.entries(p.extra)) if (items.length) body.push(H(tpl.extraTitles[k] ?? k), ...list(items));
  if (p.topics.length) { body.push(H("Ход обсуждения")); for (const t of p.topics) body.push(P(t.title + (t.speakers.length ? ` (${t.speakers.join(", ")})` : ""), { bold: true }), ...list(t.points)); }
  if (m.previous?.tasks.length) body.push(H(carryTitle(m)), ...list(m.previous.tasks.map(t => `${t.text}${t.owner ? ` — ${t.owner}` : ""}: ${CARRY_STATUS[t.status]}`)));
  if (p.openQuestions.length) body.push(H("Открытые вопросы"), ...list(p.openQuestions));
  if (p.missedAgenda.length) body.push(H("Не обсудили из повестки"), ...list(p.missedAgenda));
  if (o.withTranscript) body.push(...transcript(m));
  return new Document({
    creator: "Протоколист", title: p.title,
    styles: { default: { document: { run: { font: "Arial", size: 22 } } } },
    sections: [{ properties: { page: { margin: { top: 1134, bottom: 1134, left: 1418, right: 850 } } }, children: body }],
  });
}

/** ГОСТ Р 7.0.97-2016: полная форма протокола */
function gost(m: Meeting, p: Protocol, o: DocxOptions) {
  const C = AlignmentType.CENTER, J = AlignmentType.JUSTIFIED;
  const topics = p.topics.length ? p.topics : [{ title: p.title, speakers: [], points: [p.summary] }];
  const body: (Paragraph | Table)[] = [
    P(o.organization || "НАИМЕНОВАНИЕ ОРГАНИЗАЦИИ", { align: C, bold: true, caps: true }),
    P("ПРОТОКОЛ", { align: C, bold: true, after: 240 }),
    new Paragraph({ spacing: { after: 120 }, children: [new TextRun(`${ruDate(p.date)}`), new TextRun({ text: `\t№ ${o.number || "____"}` })], tabStops: [{ type: "right" as any, position: 9350 }] }),
    P(o.place || "место проведения", { align: C, after: 240 }),
    P(`совещания: ${p.title}`, { bold: true, after: 240 }),
    P(`Председатель — ${o.chair || "____________"}`, { after: 60 }),
    P(`Секретарь — ${o.secretary || "____________"}`, { after: 60 }),
    P(`Присутствовали: ${p.participants.join(", ")}`, { align: J, after: 240 }),
    P("ПОВЕСТКА ДНЯ:", { bold: true }),
    ...topics.map((t, i) => P(`${i + 1}. ${t.title}`, { align: J, after: 60 })),
    P("", { after: 120 }),
  ];
  topics.forEach((t, i) => {
    const n = i + 1;
    const [first, ...rest] = t.speakers;
    body.push(P(`${n}. СЛУШАЛИ:`, { bold: true, after: 60 }));
    body.push(P(`${first ? first + " — " : ""}${t.points[0] ?? ""}`, { align: J }));
    if (rest.length || t.points.length > 1) {
      body.push(P("ВЫСТУПИЛИ:", { bold: true, after: 60 }));
      t.points.slice(1).forEach((x, k) => body.push(P(`${rest[k] ? rest[k] + " — " : ""}${x}`, { align: J })));
      rest.slice(Math.max(0, t.points.length - 1)).forEach(s => body.push(P(`${s}.`, { align: J })));
    }
    const ds = p.decisions.filter(d => (d.topic ? overlaps(d.topic, t.title) : false));
    const own = ds.length ? ds : i === topics.length - 1 ? p.decisions.filter(d => !topics.some(x => d.topic && overlaps(d.topic, x.title))) : [];
    if (own.length) {
      body.push(P("РЕШИЛИ:", { bold: true, after: 60 }));
      own.forEach((d, k) => body.push(P(`${n}.${k + 1}. ${d.text}`, { align: J })));
    }
    body.push(P("", { after: 120 }));
  });
  if (p.tasks.length) body.push(P("ПОРУЧЕНИЯ:", { bold: true }), tasksTable(p), P("", { after: 240 }));
  const sign = (role: string, name?: string) => new Paragraph({ spacing: { before: 360 }, tabStops: [{ type: "left" as any, position: 4500 }, { type: "right" as any, position: 9350 }], children: [new TextRun(role), new TextRun("\t____________"), new TextRun(`\t${name || "И. О. Фамилия"}`)] });
  body.push(sign("Председатель", o.chair), sign("Секретарь", o.secretary));
  if (o.withTranscript) body.push(...transcript(m));
  return new Document({
    creator: "Протоколист", title: `Протокол ${p.title}`,
    styles: { default: { document: { run: { font: "Times New Roman", size: 28 }, paragraph: { spacing: { line: 240 } } } } },
    sections: [{ properties: { page: { margin: { top: 1134, bottom: 1134, left: 1701, right: 850 } } }, children: body }],
  });
}

function overlaps(a: string, b: string) {
  const w = (s: string) => s.toLowerCase().split(/[^\p{L}\d]+/u).filter(x => x.length > 3);
  const A = new Set(w(a));
  const B = w(b);
  return B.filter(x => A.has(x)).length / Math.max(1, Math.min(A.size, B.length)) >= 0.5;
}
