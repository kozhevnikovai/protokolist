import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { buildProtocol, groundSummary, MIN_WORDS } from "../src/protocol/build.js";
import { validateBitrixWebhook, checkTelegram } from "../src/integrations/index.js";
import { PACKS } from "../src/models.js";
import { normalize } from "../src/transcribe.js";
import { checkInput } from "../src/audio.js";
import { toHtml } from "../src/export/html.js";
import type { LLM } from "../src/protocol/llm.js";
import type { Transcript } from "../src/types.js";
import { transcript, protocol } from "./fixtures/meeting.js";

const home = mkdtempSync(join(tmpdir(), "pk-"));
process.env.PROTOKOLIST_HOME = home;
process.env.PROTOKOLIST_OUT = join(home, "out");

const short: Transcript = { ...transcript, duration: 5, speakers: [{ id: "me", label: "Я", talk: 2 }], segments: [{ start: 1, end: 3, speaker: "me", text: "Проверка записи." }] };
const llmThatInvents = (calls: string[]): LLM => ({
  name: "fake",
  async json<T>(sys: string): Promise<T> {
    calls.push(sys);
    if (sys.startsWith("Ты — секретарь совещаний. По итогам")) return { title: "Итоги", summary: "Были обсуждены ключевые решения и распределены конкретные задачи. Определены сроки выполнения и ответственные стороны. Обсудили лендинг и тестовый бюджет на рекламу.", missedAgenda: [] } as T;
    return { topics: [], decisions: [], tasks: [], openQuestions: [] } as T;
  },
  async dispose() {},
} as unknown as LLM);

describe("резюме без выдумок (1.1)", () => {
  it("короткая запись — модель не вызывается, резюме честное", async () => {
    const calls: string[] = [];
    const p = await buildProtocol(short, llmThatInvents(calls));
    expect(calls).toHaveLength(0);
    expect(p.summary).toMatch(/Короткая запись \(2 слова\): решений и задач не прозвучало/);
    expect(p.tasks).toHaveLength(0);
    expect(MIN_WORDS).toBeGreaterThan(10);
  });
  it("выдуманные фразы убираются, подтверждённые остаются", async () => {
    const p = await buildProtocol(transcript, llmThatInvents([]));
    expect(p.summary).not.toMatch(/ключевые решения|ответственные стороны/);
    expect(p.summary).toMatch(/лендинг/i);
    expect(p.meta.warnings?.join(" ")).toMatch(/не подтвердилась/);
  });
  it("groundSummary: пустое, если ничего не подтверждено", () => expect(groundSummary(short, "Утвердили бюджет и распределили задачи.")).toBe(""));
  it("в итоговый запрос идёт сама стенограмма", async () => {
    let user = "";
    const llm = { name: "x", async json(sys: string, u: string) { if (sys.includes("По итогам")) user = u; return { topics: [], decisions: [], tasks: [], openQuestions: [], title: "", summary: "", missedAgenda: [] }; }, async dispose() {} } as unknown as LLM;
    await buildProtocol(transcript, llm);
    expect(user).toMatch(/Стенограмма \(фрагмент\)/);
    expect(user).toMatch(/подключу форму до пятницы/);
  });
});

describe("подключения", () => {
  it.each([
    ["http://portal.bitrix24.ru/rest/1/abc/", /https/],
    ["https://localhost/rest/1/abc/", /локальной сети/],
    ["https://192.168.1.5/rest/1/abc/", /локальной сети/],
    ["https://169.254.169.254/rest/1/abc/", /локальной сети/],
    ["https://portal.bitrix24.ru/", /неполный/],
    ["не адрес", /не адрес/],
  ])("вебхук %s отклоняется", (u, re) => expect(validateBitrixWebhook(u)).toMatch(re));
  it("правильный вебхук проходит", () => expect(validateBitrixWebhook("https://portal.bitrix24.ru/rest/1/abc123/")).toBeNull());
  it("неверный токен Telegram — без запроса в сеть", async () => expect((await checkTelegram({ token: "abc", chatId: "1" })).message).toMatch(/Токен выглядит неверно/));
});

describe("настройки и ключи (1.13)", () => {
  let cfg: typeof import("../src/config.js");
  beforeAll(async () => { cfg = await import("../src/config.js"); });
  it("зашифрованный ключ подставляется только из памяти, на диске остаётся enc:", () => {
    cfg.saveConfig({ telegram: { token: "enc:QUJD", chatId: "5" } });
    expect(cfg.loadConfig().telegram?.token).toBe("");
    cfg.setSecrets({ "telegram.token": "123:secret" });
    expect(cfg.loadConfig().telegram?.token).toBe("123:secret");
    expect(readFileSync(cfg.configFile(), "utf8")).not.toMatch(/secret/);
    cfg.setSecrets({});
  });
  it("сохранение без ключа не стирает ключ", () => {
    cfg.saveConfig({ telegram: { chatId: "7" } as any });
    expect(cfg.rawConfig().telegram).toEqual({ token: "enc:QUJD", chatId: "7" });
  });
  it("мусорные форматы и отрицательная ставка отбрасываются", () => {
    const c = cfg.saveConfig({ formats: ["HTML", "exe", "docx", "docx"], hourlyRate: -5 });
    expect(c.formats).toEqual(["html", "docx"]);
    expect(c.hourlyRate).toBe(0);
    expect(cfg.saveConfig({ formats: ["zzz"] }).formats).toEqual(["html"]);
  });
});

describe("MCP: только папка протоколов (1.18)", () => {
  it("../ и чужие пути не открываются", async () => {
    const { resolveDir } = await import("../src/mcp.js");
    const root = join(home, "out");
    mkdirSync(join(root, "2026-11-09 Встреча"), { recursive: true });
    writeFileSync(join(root, "2026-11-09 Встреча", "встреча.json"), "{}");
    const outside = join(home, "secret");
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "встреча.json"), "{}");
    expect(resolveDir("2026-11-09 Встреча", root)).toMatch(/Встреча$/);
    expect(() => resolveDir("../secret", root)).toThrow(/только встречи из папки/);
    expect(() => resolveDir(outside, root)).toThrow(/только встречи из папки/);
    symlinkSync(outside, join(root, "link"));
    expect(() => resolveDir("link", root)).toThrow(/только встречи из папки/);
  });
});

describe("модели и звук", () => {
  it("у каждого файла есть SHA-256", () => { for (const f of Object.values(PACKS).flatMap(p => p.files)) expect(f.sha256).toMatch(/^[0-9a-f]{64}$/); });
  it("тихая запись усиливается, но не больше чем в 30 раз", () => {
    const S = new Float32Array(16000).map((_, i) => 0.02 * Math.sin(i / 5));
    expect(Math.max(...normalize(S))).toBeGreaterThan(0.55);
    const Q = new Float32Array(16000).map((_, i) => 0.001 * Math.sin(i / 5));
    expect(Math.max(...normalize(Q))).toBeLessThanOrEqual(0.0301);
    expect(normalize(new Float32Array(100))).toHaveLength(100);
  });
  it("URL и пустые файлы не передаются в ffmpeg", () => {
    expect(() => checkInput("https://example.com/a.mp3")).toThrow(/не найден/);
    writeFileSync(join(home, "empty.mp3"), "");
    expect(() => checkInput(join(home, "empty.mp3"))).toThrow(/пустой/);
    expect(() => checkInput(home)).toThrow(/папка/);
  });
});

describe("XSS в протоколе", () => {
  it("имена, задачи и название экранируются", () => {
    const evil = '<img src=x onerror=alert(1)>';
    const html = toHtml({ transcript: { ...transcript, speakers: transcript.speakers.map(s => ({ ...s, label: evil })) }, protocol: { ...protocol, title: evil, tasks: protocol.tasks.map(t => ({ ...t, owner: evil, text: evil })) }, analytics: undefined as any });
    expect(html).not.toContain(evil);
    expect(html).toContain("&lt;img");
  });
});

describe("словарь: варианты через запятую", () => {
  it("«Битрикс24 = битрикс двадцать четыре, битрикс» понимается как два варианта", async () => {
    const { parseGlossary, applyGlossary } = await import("../src/glossary.js");
    const g = parseGlossary("Битрикс24 = битрикс двадцать четыре, битрикс\nKPI = кей пи ай");
    expect(applyGlossary("Ставим в битрикс двадцать четыре, считаем кей пи ай.", g)).toBe("Ставим в Битрикс24, считаем KPI.");
  });
});

describe("словарь: устойчивость", () => {
  it("«$» в термине не ломает текст, словарь ограничен по размеру", async () => {
    const { parseGlossary, applyGlossary, MAX_TERMS } = await import("../src/glossary.js");
    expect(applyGlossary("план на сто баксов", parseGlossary("$100 = сто баксов"))).toBe("план на $100");
    expect(parseGlossary(Array.from({ length: 1000 }, (_, i) => `Т${i}`).join("\n"))).toHaveLength(MAX_TERMS);
    expect(parseGlossary("а".repeat(5000))).toHaveLength(0);
  });
});
