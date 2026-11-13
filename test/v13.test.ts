import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { askArchive, monthOf, passages, retrieve, stem } from "../src/ask.js";
import { catchUp, lastMinutes, LiveTranscriber, type LiveLine, type StreamVad } from "../src/live.js";
import { transcriptDigest } from "../src/protocol/build.js";
import type { LLM } from "../src/protocol/llm.js";
import { protocol, transcript } from "./fixtures/meeting.js";

const root = mkdtempSync(join(tmpdir(), "pk13-"));
function meeting(name: string, date: string, title: string, decision: string, says: string) {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  const tr = { ...transcript, date, segments: [...transcript.segments, { start: 130, end: 140, speaker: "s1", text: says }] };
  const pr = { ...protocol, title, date, summary: `Встреча «${title}».`, decisions: [{ text: decision, quote: "", t: 130 }] };
  writeFileSync(join(dir, "встреча.json"), JSON.stringify({ transcript: tr, protocol: pr }));
}
meeting("2026-10-07 Цены", "2026-10-07", "Цены на осень", "Поднять цены на тариф «Бизнес» на 10 % с ноября", "Повышаем цены на бизнес-тариф, клиентов предупредим письмом.");
meeting("2026-11-05 Цены", "2026-11-05", "Цены и скидки", "Скидку для новых клиентов на цены не давать", "По ценам: скидку новым клиентам не даём.");
meeting("2026-11-06 Найм", "2026-11-06", "Найм", "Открыть вакансию дизайнера", "Нужен дизайнер, открываем вакансию.");

describe("чат по архиву: поиск", () => {
  it("основа слова и месяц из вопроса", () => {
    expect(stem("ценам")).toBe(stem("цены"));
    expect(monthOf("Что решили про цены в октябре?")).toBe(10);
    expect(monthOf("итоги за май")).toBe(5);
    expect(monthOf("что решили про цены")).toBeNull();
  });
  it("решения выше реплик, месяц из вопроса поднимает встречи этого месяца", () => {
    const f = retrieve(passages(root), "что решили про цены в октябре", 5);
    expect(f[0].date).toBe("2026-10-07");
    expect(f[0].kind).toBe("решение");
    expect(f.map(x => x.n)).toEqual([1, 2, 3, 4, 5].slice(0, f.length));
    expect(retrieve(passages(root), "космодром луна", 5)).toEqual([]);
  });
});

const fakeLlm = (answer: { answer: string; sources: number[] }, seen: string[] = []): LLM => ({
  name: "тест", async json<T>(_s: string, u: string) { seen.push(u); return answer as T; },
  async text(_s: string, u: string, _m?: number, o?: { onText?: (t: string) => void }) { seen.push(u); o?.onText?.("— пересказ"); return "— пересказ"; },
  async dispose() {},
});

describe("чат по архиву: ответ", () => {
  it("ответ со ссылками только на найденные фрагменты", async () => {
    const seen: string[] = [];
    const r = await askArchive(root, "что решили про цены в октябре", fakeLlm({ answer: "7 октября решили поднять цены на «Бизнес» на 10 %.", sources: [1, 99, 1] }, seen));
    expect(r.model).toBe(true);
    expect(r.sources).toHaveLength(1); // 99 — несуществующий, повтор убран
    expect(r.sources[0].date).toBe("2026-10-07");
    expect(seen[0]).toContain("[1] 2026-10-07");
  });
  it("без ссылок — не выдаём ответ модели за факт", async () => {
    const r = await askArchive(root, "цены", fakeLlm({ answer: "Цены подняли на 50 %", sources: [] }));
    expect(r.answer).not.toContain("50 %");
    expect(r.sources.length).toBeGreaterThan(0);
  });
  it("ничего не нашлось — модель не вызывается", async () => {
    const seen: string[] = [];
    const r = await askArchive(root, "космодром луна", fakeLlm({ answer: "x", sources: [1] }, seen));
    expect(r.model).toBe(false);
    expect(seen).toHaveLength(0);
  });
  it("без модели — только фрагменты", async () => {
    const r = await askArchive(root, "вакансия дизайнера", null);
    expect(r.sources[0].title).toBe("Найм");
  });
});

describe("живые субтитры", () => {
  // детектор речи-заглушка: каждые 16000 отсчётов громкого звука — фраза
  const fakeVad = (): StreamVad => {
    let pos = 0; let start = -1; const out: { start: number; samples: Float32Array }[] = []; let buf: number[] = [];
    return {
      accept(s) { for (const x of s) { if (Math.abs(x) > 0.05) { if (start < 0) start = pos; buf.push(x); if (buf.length >= 16000) { out.push({ start, samples: Float32Array.from(buf) }); buf = []; start = -1; } } pos++; } },
      take() { return out.splice(0); },
      flush() { if (buf.length) { out.push({ start, samples: Float32Array.from(buf) }); buf = []; start = -1; } },
    };
  };
  it("фразы → строки с временем, словарь применяется, пустое распознавание пропускается", () => {
    const lines: LiveLine[] = [];
    let n = 0;
    const t = new LiveTranscriber({ source: "me", vad: fakeVad(), recognize: () => (++n === 2 ? "" : "битрикс двадцать четыре готов"), glossary: [{ term: "Битрикс24", variants: ["битрикс двадцать четыре"] }], onLine: l => lines.push(l) });
    const loud = new Float32Array(16000).fill(0.5), silent = new Float32Array(8000);
    t.push(silent); t.push(loud); t.push(loud); t.push(loud.subarray(0, 4000));
    t.finish();
    expect(lines.map(l => l.text)).toEqual(["Битрикс24 готов", "Битрикс24 готов"]);
    expect(lines[0]).toMatchObject({ source: "me", start: 0.5, end: 1.5 });
    expect(t.received).toBe(8000 + 16000 * 2 + 4000);
  });
  it("тихая гарнитура усиливается, но не больше чем в 30 раз", () => {
    const got: number[] = [];
    const t = new LiveTranscriber({ source: "others", vad: { accept: s => { got.push(Math.max(...s)); }, take: () => [], flush() {} }, recognize: () => "", onLine: () => {} });
    for (let i = 0; i < 40; i++) t.push(new Float32Array(1600).fill(0.01));
    expect(got.at(-1)!).toBeGreaterThan(0.1);
    expect(got.at(-1)!).toBeLessThanOrEqual(0.3 + 1e-6);
  });
});

describe("«Что я пропустил?»", () => {
  const line = (start: number, text: string, source: "me" | "others" = "others"): LiveLine => ({ source, start, end: start + 5, text });
  it("последние минуты", () => {
    const ls = [line(0, "а"), line(400, "б"), line(600, "в")];
    expect(lastMinutes(ls, 5).map(l => l.text)).toEqual(["б", "в"]);
  });
  it("мало речи — без модели и честно", async () => {
    const seen: string[] = [];
    const r = await catchUp([line(10, "алло меня слышно")], fakeLlm({ answer: "", sources: [] }, seen));
    expect(r.model).toBe(false);
    expect(seen).toHaveLength(0);
  });
  it("пересказ по фрагменту с подписями и потоком текста", async () => {
    const seen: string[] = []; const chunks: string[] = [];
    const ls = [line(100, "Предлагаю перенести запуск лендинга на следующую неделю из-за формы заявки"), line(110, "Иван, ты успеешь подготовить отчёт по рекламе к четвергу? Нужен ответ сегодня", "others"), line(120, "Да, успею", "me")];
    const r = await catchUp(ls, fakeLlm({ answer: "", sources: [] }, seen), { minutes: 5, onText: t => chunks.push(t) });
    expect(r.model).toBe(true);
    expect(seen[0]).toContain("Я: Да, успею");
    expect(seen[0]).toContain("Встреча: Предлагаю");
    expect(chunks).toEqual(["— пересказ"]);
  });
});

describe("длинные встречи", () => {
  it("в итоговый запрос попадают кусочки всех частей, а не только начало", () => {
    const chunks = Array.from({ length: 6 }, (_, i) => Array.from({ length: 50 }, (_, j) => `[${i}:${j}] часть ${i} реплика ${j}`).join("\n"));
    const d = transcriptDigest(chunks, 6000);
    for (let i = 0; i < 6; i++) expect(d).toContain(`часть ${i} реплика 0`);
    expect(d.length).toBeLessThanOrEqual(6000 + 6 * 4);
  });
});
