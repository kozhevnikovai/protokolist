// MCP-сервер: Claude Desktop и другие клиенты расшифровывают встречи локально,
// а протокол может составить сам Claude — без своей языковой модели и ключей.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { z } from "zod";
import { hitLine, listMeetings, load, searchMeetings } from "./archive.js";
import { loadConfig } from "./config.js";
import { toMarkdown } from "./export/text.js";
import { download, missing } from "./models.js";
import { finish, run } from "./pipeline.js";
import { locateQuote } from "./protocol/build.js";
import { parseDue } from "./protocol/dates.js";
import { getTemplate, TEMPLATES } from "./protocol/templates.js";
import { transcriptText } from "./transcribe.js";
import type { Protocol } from "./types.js";
import { VERSION } from "./version.js";

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });

/** id встречи → папка. Только внутри папки протоколов: «../», чужие абсолютные пути и ссылки наружу отклоняются. */
export function resolveDir(id: string, root = loadConfig().outputDir) {
  const notFound = new Error(`Встреча «${id}» не найдена. Список — инструмент list_meetings.`);
  if (!existsSync(root)) throw notFound;
  const base = realpathSync(root);
  const cand = isAbsolute(id) ? id : join(base, id);
  if (!existsSync(join(cand, "встреча.json"))) throw notFound;
  const real = realpathSync(cand);
  const rel = relative(base, real);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error("Можно открывать только встречи из папки протоколов");
  return real;
}

export function buildServer(): McpServer {
  const server = new McpServer({ name: "protokolist", version: VERSION });

  server.registerTool("transcribe_meeting", {
    title: "Расшифровать встречу",
    description: "Локально расшифровывает запись встречи (любой аудио/видеофайл) на русском языке с разделением по спикерам. Ничего не отправляет в сеть. Возвращает id встречи и стенограмму с тайм-кодами. Дальше составь протокол сам и сохрани его инструментом save_protocol. Занимает примерно 1/8 длительности записи.",
    inputSchema: {
      file: z.string().describe("Полный путь к файлу записи"),
      speakers: z.number().int().min(1).max(20).optional().describe("Точное число участников, если известно"),
      names: z.record(z.string(), z.string()).optional().describe('Имена спикеров: {"s1":"Иван","me":"Егор"}'),
      date: z.string().optional().describe("Дата встречи YYYY-MM-DD"),
    },
  }, async ({ file, speakers, names, date }) => {
    if (missing(["asr", "speakers"]).length) await download(["asr", "speakers"]);
    const r = await run(file, { config: loadConfig(), speakers, names, date, noProtocol: true, formats: ["txt"] });
    const tr = r.meeting.transcript;
    return text(`id: ${r.dir.split(/[\\/]/).pop()}\nПапка: ${r.dir}\nДата: ${tr.date} · длительность ${Math.round(tr.duration / 60)} мин · спикеры: ${tr.speakers.map(s => `${s.id}=${s.label}`).join(", ")}\n\nСтенограмма:\n${transcriptText(tr)}\n\nСоставь протокол по правилам: только то, что прозвучало; у каждого решения и задачи — дословная цитата 5–15 слов; срок — как сказали. Затем вызови save_protocol. Если спикеров нужно переименовать — передай names в save_protocol.`);
  });

  const item = z.object({ text: z.string(), quote: z.string().describe("Дословная цитата 5–15 слов из стенограммы") });
  server.registerTool("save_protocol", {
    title: "Сохранить протокол",
    description: `Проверяет протокол по стенограмме (находит цитаты и тайм-коды, вычисляет даты сроков) и сохраняет HTML («Чертёж»), DOCX и Markdown в папку встречи. Шаблоны: ${Object.values(TEMPLATES).map(t => `${t.id} — ${t.title}`).join("; ")}.`,
    inputSchema: {
      id: z.string().describe("id встречи из transcribe_meeting"),
      template: z.enum(Object.keys(TEMPLATES) as [string, ...string[]]).default("planerka"),
      title: z.string(), summary: z.string(),
      decisions: z.array(item.extend({ topic: z.string().optional() })),
      tasks: z.array(item.extend({ owner: z.string().describe("Ответственный или пустая строка"), due: z.string().describe("Срок как сказали или пустая строка") })),
      topics: z.array(z.object({ title: z.string(), speakers: z.array(z.string()), points: z.array(z.string()) })).default([]),
      open_questions: z.array(z.string()).default([]),
      extra: z.record(z.string(), z.array(z.string())).default({}).describe("Поля шаблона, напр. для sales: needs, objections, budget, nextStep"),
      names: z.record(z.string(), z.string()).optional().describe('Переименовать спикеров: {"s1":"Иван"}'),
    },
  }, async a => {
    const dir = resolveDir(a.id);
    const m = load(dir);
    const tr = m.transcript;
    const tpl = getTemplate(a.template);
    const protocol: Protocol = {
      title: a.title, date: tr.date, template: tpl.id, participants: tr.speakers.map(s => a.names?.[s.id] ?? s.label), summary: a.summary,
      topics: a.topics,
      decisions: a.decisions.map(d => ({ ...d, t: locateQuote(tr, d.quote) })),
      tasks: a.tasks.map(x => { const t = locateQuote(tr, x.quote); const due = parseDue(x.due, tr.date); return { text: x.text, owner: x.owner, dueText: x.due, due, quote: x.quote, t, review: t === null || !x.owner || (!!x.due && !due) }; }),
      openQuestions: a.open_questions, missedAgenda: [],
      extra: Object.fromEntries(Object.keys(tpl.extra).map(k => [k, a.extra[k] ?? []])),
      meta: { model: "Claude (через MCP)", seconds: 0, generatedAt: new Date().toISOString() },
    };
    // finish без модели: протокол уже готов — подставляем его через noProtocol и дописываем
    const r = await finish(tr, null, { config: loadConfig(), outDir: dir, names: a.names, noProtocol: true, formats: [] });
    r.meeting.protocol = protocol;
    const { toHtml } = await import("./export/html.js");
    const { toDocx } = await import("./export/docx.js");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(dir, "встреча.json"), JSON.stringify(r.meeting, null, 2));
    writeFileSync(join(dir, "протокол.html"), toHtml(r.meeting));
    writeFileSync(join(dir, "протокол.md"), toMarkdown(r.meeting));
    writeFileSync(join(dir, "протокол.docx"), await toDocx(r.meeting, { ...loadConfig().gost, withTranscript: true }));
    const bad = protocol.tasks.filter(t => t.review).map(t => t.text);
    return text(`Сохранено в ${dir}: протокол.html, протокол.docx, протокол.md.\nЗадач: ${protocol.tasks.length}, решений: ${protocol.decisions.length}.${bad.length ? `\nТребуют проверки (цитата не найдена, нет ответственного или неясен срок): ${bad.join("; ")}` : "\nВсе пункты подтверждены цитатами."}`);
  });

  server.registerTool("make_protocol", {
    title: "Протокол полностью локально",
    description: "Расшифровка и протокол целиком на компьютере пользователя встроенной языковой моделью (без Claude и без сети). Дольше, чем transcribe_meeting + save_protocol, но ни одно слово встречи не уходит наружу.",
    inputSchema: { file: z.string(), template: z.enum(Object.keys(TEMPLATES) as [string, ...string[]]).default("planerka"), speakers: z.number().int().optional(), agenda: z.array(z.string()).optional() },
  }, async ({ file, template, speakers, agenda }) => {
    if (missing().length) await download();
    const r = await run(file, { config: loadConfig(), template, speakers, agenda, keepAudio: true });
    return text(`Папка: ${r.dir}\n\n${toMarkdown(r.meeting).split("\n## Стенограмма")[0]}`);
  });

  server.registerTool("list_meetings", { title: "Архив встреч", description: "Список сохранённых встреч: дата, название, число задач, id.", inputSchema: {} }, async () => {
    const ms = listMeetings(loadConfig().outputDir);
    return text(ms.length ? ms.map(m => `${m.id} · ${m.date} · ${m.title} · задач: ${m.tasks}`).join("\n") : "Архив пуст.");
  });

  server.registerTool("search_meetings", {
    title: "Поиск по встречам",
    description: "Ищет по всем протоколам и стенограммам: решения, задачи и реплики с тайм-кодами. Например: «цена», «Иван отчёт».",
    inputSchema: { query: z.string() },
  }, async ({ query }) => {
    const hits = searchMeetings(loadConfig().outputDir, query);
    return text(hits.length ? hits.map(hitLine).join("\n") : "Ничего не нашлось.");
  });

  server.registerTool("get_meeting", { title: "Протокол встречи", description: "Протокол и стенограмма встречи по id в Markdown.", inputSchema: { id: z.string() } }, async ({ id }) => text(toMarkdown(load(resolveDir(id)))));

  return server;
}

export async function startMcp() {
  await buildServer().connect(new StdioServerTransport());
}
