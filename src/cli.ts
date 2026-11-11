#!/usr/bin/env node
// Командная строка Протоколиста
import { existsSync, readFileSync } from "node:fs";
import { Command } from "commander";
import { hitLine, listMeetings, searchMeetings } from "./archive.js";
import { loadConfig, saveConfig, setPath } from "./config.js";
import { download, LLM_MODELS, missing, PACKS, selectLlm } from "./models.js";
import { detectHardware, recommend } from "@kozhevnikovai/local-ai";
import { FORMATS, run } from "./pipeline.js";
import { TEMPLATES } from "./protocol/templates.js";
import { fmtTime } from "./transcribe.js";
import { VERSION } from "./version.js";
import { listVoices } from "./voices.js";

const STAGES: Record<string, string> = { decode: "Чтение аудио", vad: "Поиск речи", speakers: "Спикеры", asr: "Распознавание", protocol: "Протокол" };

function bar(label: string, done: number, total: number) {
  if (!process.stderr.isTTY) return;
  const w = 24, k = total ? Math.round((done / total) * w) : 0;
  process.stderr.write(`\r${label.padEnd(14)} [${"█".repeat(k)}${"·".repeat(w - k)}] ${total ? Math.round((done / total) * 100) : 0}%   `);
  if (done >= total) process.stderr.write("\n");
}

const parseNames = (s?: string) => Object.fromEntries((s ?? "").split(",").map(x => x.split("=").map(y => y.trim())).filter(x => x.length === 2 && x[0] && x[1]));
const parseAgenda = (s?: string) => !s ? undefined : (existsSync(s) ? readFileSync(s, "utf8") : s).split(/\r?\n|;/).map(x => x.trim()).filter(Boolean);

const program = new Command("protokolist")
  .description("Протоколист — запись встречи → протокол с решениями и задачами. Локально, без облака.")
  .version(VERSION)
  .argument("[file]", "аудио или видео встречи (wav, mp3, m4a, ogg, mp4, webm…)")
  .option("-t, --template <id>", `шаблон: ${Object.keys(TEMPLATES).join(", ")}`)
  .option("-s, --speakers <n>", "точное число участников", v => Number(v))
  .option("-n, --names <map>", 'имена спикеров: "s1=Иван,s2=Ольга" (me — владелец микрофона)')
  .option("-a, --agenda <text|file>", 'повестка: "пункт; пункт" или файл')
  .option("-f, --formats <list>", `форматы: ${FORMATS.join(",")}`)
  .option("-o, --out <dir>", "папка для результата")
  .option("--date <YYYY-MM-DD>", "дата встречи (по умолчанию сегодня)")
  .option("--mic <file>", "отдельная запись микрофона владельца")
  .option("--no-protocol", "только стенограмма")
  .option("--keep-audio", "положить запись рядом с протоколом (тайм-коды проигрываются)")
  .option("--send <list>", "отправить: bitrix24,yougile,telegram,kaiten,tracker,pachca (нужен выключенный офлайн-режим), obsidian (заметка, без сети)")
  .option("--series <name>", "серия встреч: в протокол попадут задачи с прошлой встречи серии")
  .option("--gpu <type>", "auto, cpu, cuda, vulkan")
  .action(async (file: string | undefined, o) => {
    if (!file) return program.help();
    if (!existsSync(file)) throw new Error(`Файл не найден: ${file}`);
    const config = loadConfig();
    if (o.gpu) config.llm.gpu = o.gpu;
    const need = missing(o.protocol === false ? ["asr", "speakers"] : undefined);
    if (need.length) { console.error("Сначала скачаю модели (один раз)…"); await download(undefined, e => bar(e.file.split("/").pop()!.slice(0, 14), e.done, e.total)); }
    const t0 = Date.now();
    const r = await run(file, {
      config, outDir: o.out, template: o.template, speakers: o.speakers, names: parseNames(o.names), agenda: parseAgenda(o.agenda),
      formats: o.formats?.split(","), noProtocol: o.protocol === false, send: o.send?.split(","), keepAudio: o.keepAudio, micFile: o.mic, date: o.date, series: o.series,
      voices: config.voices ? listVoices() : undefined,
      onProgress: (s, d, t) => bar(STAGES[s] ?? s, d, t),
    });
    const tr = r.meeting.transcript, p = r.meeting.protocol;
    console.log(`\n${p ? p.title : "Стенограмма готова"} · ${fmtTime(tr.duration)} · ${tr.speakers.map(s => s.label).join(", ")}`);
    if (p) console.log(`Решений: ${p.decisions.length} · задач: ${p.tasks.length}${p.tasks.some(t => t.review) ? ` (проверить: ${p.tasks.filter(t => t.review).length})` : ""}`);
    console.log(`Готово за ${fmtTime((Date.now() - t0) / 1000)} · отправлено в сеть: ${r.netBytes} байт`);
    for (const s of r.sent) console.log(`${s.target}: отправлено ${s.ok}${s.failed.length ? `, ошибки: ${s.failed.map(f => f.error).join("; ")}` : ""}`);
    console.log(`Папка: ${r.dir}`);
  });

program.command("models").description("скачать модели (один раз; языковая модель выбирается по компьютеру)")
  .option("--no-llm", "без языковой модели (только стенограммы или протокол через Claude)")
  .option("--model <id>", `языковая модель: ${LLM_MODELS.map(m => m.id).join(", ")}`)
  .action(async o => {
  let id = o.model ?? loadConfig().llm.localModel;
  if (!id && o.llm !== false) {
    const r = recommend(await detectHardware());
    console.log(r.reason);
    id = r.model.id;
  }
  if (id) { selectLlm(id); if (id !== loadConfig().llm.localModel) saveConfig({ llm: { localModel: selectLlm(id) } } as any); }
  const packs = o.llm === false ? ["asr", "speakers"] : Object.keys(PACKS);
  const need = missing(packs);
  if (!need.length) return console.log("Все модели на месте.");
  for (const id of packs) console.log(`• ${PACKS[id].title} — ${PACKS[id].license}`);
  await download(packs, e => bar(e.file.split("/").pop()!.slice(0, 14), e.done, e.total));
  console.log("Готово. Дальше всё работает без интернета.");
});

program.command("templates").description("шаблоны протоколов").action(() => {
  for (const t of Object.values(TEMPLATES)) console.log(`${t.id.padEnd(10)} ${t.title}`);
});

program.command("config").description("показать или изменить настройки: config offline false").argument("[key]").argument("[value]").action((key?: string, value?: string) => {
  const c = loadConfig() as any;
  if (!key) return console.log(JSON.stringify(c, (k, v) => (/token|key|webhook/i.test(k) && typeof v === "string" ? v.slice(0, 6) + "…" : v), 2));
  let v: any = value;
  try { v = JSON.parse(value!); } catch { /* строка */ }
  const patch: any = {};
  setPath(patch, key, v);
  saveConfig(patch);
  console.log(`${key} = ${JSON.stringify(v)}`);
});

program.command("list").description("архив встреч").action(() => {
  for (const m of listMeetings(loadConfig().outputDir)) console.log(`${m.date}  ${fmtTime(m.duration).padStart(8)}  задач: ${String(m.tasks).padStart(2)}  ${m.title}`);
});

program.command("search").description("поиск по всем встречам").argument("<query...>").action((q: string[]) => {
  const hits = searchMeetings(loadConfig().outputDir, q.join(" "));
  console.log(hits.length ? hits.map(hitLine).join("\n") : "Ничего не нашлось.");
});

program.command("mcp").description("MCP-сервер для Claude Desktop и других клиентов").action(async () => {
  const { startMcp } = await import("./mcp.js");
  await startMcp();
});

program.parseAsync().catch(e => { console.error(`\nОшибка: ${e.message}`); process.exit(1); });
