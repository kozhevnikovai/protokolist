import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { listTasks } from "../src/archive.js";
import { saveConfig, loadConfig } from "../src/config.js";
import { toHtml } from "../src/export/html.js";
import { toMarkdown } from "../src/export/text.js";
import { checkKaiten, checkTracker, kaitenBase, pachcaText, saveToObsidian, sendToKaiten, sendToPachca, sendToTracker, toObsidian } from "../src/integrations/more.js";
import { setOffline } from "../src/net.js";
import { finish } from "../src/pipeline.js";
import { carryOver, findMention, listSeries, setTaskDone } from "../src/series.js";
import { centroidsOf, forgetVoice, learnVoices, listVoices, matchVoices } from "../src/voices.js";
import { renameSpeakers } from "../src/transcribe.js";
import { macMeeting, CALL } from "../app/recctl.mjs";
import { protocol, transcript } from "./fixtures/meeting.js";

const home = mkdtempSync(join(tmpdir(), "pk12-"));
process.env.PROTOKOLIST_HOME = home;
process.env.PROTOKOLIST_OUT = join(home, "out");
afterEach(() => { vi.unstubAllGlobals(); setOffline(false); });

// случайный единичный вектор и «тот же голос» с шумом
const rnd = (seed: number) => { let x = seed; return () => ((x = (x * 16807) % 2147483647) / 2147483647) - 0.5; };
const vec = (seed: number, n = 192) => { const r = rnd(seed); const v = Array.from({ length: n }, r); const s = Math.hypot(...v); return v.map(x => x / s); };
const noisy = (v: number[], k: number, seed: number) => { const r = rnd(seed); const w = v.map(x => x + r() * k); const s = Math.hypot(...w); return w.map(x => x / s); };

describe("знакомые голоса", () => {
  it("запоминает подписанного и узнаёт его в новой встрече, чужого — нет", () => {
    const ivan = vec(7), olga = vec(99);
    expect(learnVoices({ s1: ivan, s2: olga }, { s1: "Иван Петров", s2: "Спикер 2" })).toEqual(["Иван Петров"]); // «Спикер 2» не имя
    const got = matchVoices({ s1: vec(12345), s2: noisy(ivan, 0.04, 3) });
    expect(got).toEqual({ s2: "Иван Петров" });
  });
  it("одно имя — одному спикеру; повторное обучение усредняет", () => {
    const ivan = listVoices()[0].emb;
    expect(Object.values(matchVoices({ s1: noisy(ivan, 0.03, 5), s2: noisy(ivan, 0.05, 6) }))).toEqual(["Иван Петров"]);
    learnVoices({ s3: noisy(ivan, 0.03, 8) }, { s3: "иван петров" });
    expect(listVoices().find(v => v.name === "Иван Петров")!.n).toBe(2);
  });
  it("центроиды: «Я» и короткие реплики не участвуют", () => {
    const c = centroidsOf([{ speaker: "me", emb: vec(1), start: 0, end: 30 }, { speaker: "s1", emb: vec(2), start: 0, end: 3 }, { speaker: "s2", emb: vec(3), start: 0, end: 6 }]);
    expect(Object.keys(c)).toEqual(["s2"]);
  });
  it("забыть голос; переименование снимает отметку «узнан»", () => {
    expect(forgetVoice("Иван Петров")).toBe(true);
    expect(listVoices()).toHaveLength(0);
    const t = renameSpeakers({ ...transcript, speakers: [{ id: "s1", label: "Иван", talk: 5, known: true }] }, { s1: "Пётр" });
    expect(t.speakers[0]).toMatchObject({ label: "Пётр" });
    expect(t.speakers[0].known).toBeUndefined();
  });
  it("выключено по умолчанию; отпечатки не попадают в архив", async () => {
    expect(loadConfig().voices).toBe(false);
    const r = await finish({ ...transcript, voices: { s1: vec(4) } }, null, { config: { ...loadConfig(), voices: true }, names: { s1: "Иван" }, noProtocol: true, formats: ["json"] });
    expect(readFileSync(join(r.dir, "встреча.json"), "utf8")).not.toContain("voices");
    expect(listVoices().map(v => v.name)).toEqual(["Иван"]);
  });
});

describe("серии встреч", () => {
  const out = process.env.PROTOKOLIST_OUT!;
  const save = (name: string, date: string, extra: object) => {
    const d = join(out, name); mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "встреча.json"), JSON.stringify({ transcript: { ...transcript, date }, protocol: { ...protocol, date }, ...extra }));
    return d;
  };
  it("находит упоминание задачи в стенограмме", () => {
    expect(findMention("Подключить форму заявки на лендинге", transcript)).toBe(13);
    expect(findMention("Нанять дизайнера в команду", transcript)).toBeNull();
  });
  it("задачи с прошлой встречи: выполнено, обсуждали, не выполнено", async () => {
    save("2026-11-02 Планёрка", "2026-11-02", { series: "Планёрка", protocol: { ...protocol, date: "2026-11-02", tasks: [
      { ...protocol.tasks[0], done: true }, { ...protocol.tasks[1], text: "Подготовить рекламную кампанию" }, { ...protocol.tasks[1], text: "Нанять дизайнера" }] } });
    expect(listSeries(out)).toEqual(["Планёрка"]);
    const r = await finish(transcript, null, { config: loadConfig(), noProtocol: true, formats: ["json"], series: "  Планёрка " });
    const pv = r.meeting.previous!;
    expect(pv.date).toBe("2026-11-02");
    expect(pv.tasks.map(t => t.status)).toEqual(["done", "discussed", "open"]);
    expect(r.meeting.series).toBe("Планёрка");
    const md = toMarkdown({ ...r.meeting, protocol });
    expect(md).toContain("## С прошлой встречи (02.11.2026)");
    expect(md).toContain("Нанять дизайнера — Ольга · не выполнено");
    expect(toHtml({ ...r.meeting, protocol })).toContain('class="st-open">не выполнено');
  });
  it("невыполненное тянется дальше по цепочке", () => {
    const prev = { transcript, protocol: { ...protocol, tasks: [] }, previous: { title: "x", date: "2026-10-26", tasks: [{ text: "Обновить прайс", owner: "", due: null, status: "open" as const, at: null, from: "2026-10-26" }, { text: "Старое", owner: "", due: null, status: "done" as const, at: null, from: "2026-10-26" }] } };
    expect(carryOver(prev, transcript).map(t => t.text)).toEqual(["Обновить прайс"]);
  });
  it("отметка «выполнено» сохраняется и видна во вкладке «Задачи»", () => {
    const t = listTasks(out).find(x => x.text === "Нанять дизайнера")!;
    setTaskDone(out, t.id, t.index, true);
    expect(listTasks(out).find(x => x.text === "Нанять дизайнера")!.done).toBe(true);
    expect(() => setTaskDone(out, "../../etc", 0, true)).toThrow(/не найдена/);
  });
});

describe("подключения 1.2", () => {
  it("Kaiten: адрес только https и не локальный", () => {
    expect(kaitenBase("company.kaiten.ru")).toBe("https://company.kaiten.ru");
    expect(kaitenBase("http://company.kaiten.ru")).toBeNull();
    expect(kaitenBase("192.168.1.5")).toBeNull();
    expect(kaitenBase("localhost")).toBeNull();
  });
  it("Kaiten: карточки с доской, колонкой и сроком", async () => {
    const calls: any[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: any) => { calls.push({ url, init }); return new Response(JSON.stringify({ id: 77 }), { status: 200 }); }));
    const r = await sendToKaiten(protocol, { domain: "company.kaiten.ru", token: "k", boardId: "5", columnId: "9" });
    expect(r).toMatchObject({ ok: 2, failed: [], links: ["https://company.kaiten.ru/77", "https://company.kaiten.ru/77"] });
    const b = JSON.parse(calls[0].init.body);
    expect(calls[0].url).toBe("https://company.kaiten.ru/api/latest/cards");
    expect(b).toMatchObject({ board_id: 5, column_id: 9, title: "Подключить форму заявки на лендинге" });
    expect(b.due_date.startsWith("2026-11-13")).toBe(true);
    expect(calls[0].init.headers.authorization).toBe("Bearer k");
  });
  it("Kaiten: проверка без сети ловит пустые поля", async () => {
    expect((await checkKaiten({ domain: "", token: "", boardId: "", columnId: "" })).ok).toBe(false);
    expect((await checkKaiten({ domain: "a.kaiten.ru", token: "x", boardId: "abc", columnId: "1" })).message).toMatch(/числа/);
  });
  it("Яндекс Трекер: очередь, срок, заголовок организации", async () => {
    const calls: any[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: any) => { calls.push({ url, init }); return new Response(JSON.stringify({ key: "SALES-1" }), { status: 201 }); }));
    const r = await sendToTracker(protocol, { token: "t", orgId: "123", queue: "sales" });
    expect(r.ok).toBe(2);
    expect(r.links[0]).toBe("https://tracker.yandex.ru/SALES-1");
    expect(JSON.parse(calls[0].init.body)).toMatchObject({ queue: "SALES", deadline: "2026-11-13" });
    expect(calls[0].init.headers).toMatchObject({ authorization: "OAuth t", "x-org-id": "123" });
    await sendToTracker(protocol, { token: "t", orgId: "b1g", cloud: true, queue: "S" });
    expect(calls.at(-1).init.headers["x-cloud-org-id"]).toBe("b1g");
    expect((await checkTracker({ token: "t", orgId: "1", queue: "очередь" })).message).toMatch(/латиницей/);
  });
  it("Пачка: одно сообщение в беседу, не длиннее лимита", async () => {
    const calls: any[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: any) => { calls.push({ url, init }); return new Response("{}", { status: 200 }); }));
    const r = await sendToPachca(protocol, { token: "p", chatId: "42" });
    expect(r.ok).toBe(1);
    expect(JSON.parse(calls[0].init.body).message).toMatchObject({ entity_type: "discussion", entity_id: 42 });
    expect(pachcaText({ ...protocol, summary: "а".repeat(5000) }).length).toBeLessThan(4000);
  });
  it("строгий офлайн блокирует сетевые подключения", async () => {
    setOffline(true);
    vi.stubGlobal("fetch", vi.fn());
    const r = await sendToPachca(protocol, { token: "p", chatId: "42" });
    expect(r.failed[0].error).toMatch(/офлайн/);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("Obsidian: заметка с задачами в формате Tasks и ссылкой на прошлую встречу", () => {
    const vault = mkdtempSync(join(tmpdir(), "vault-"));
    const m = { transcript, protocol: { ...protocol, title: "Планёрка: итоги / план" }, series: "Планёрка", previous: { title: "Старт", date: "2026-11-02", tasks: [] } };
    const r = saveToObsidian(m, { vault, folder: "../../Встречи" });
    expect(r.ok).toBe(1);
    expect(r.links[0].startsWith(vault)).toBe(true); // подпапка не выходит за хранилище
    const note = readFileSync(r.links[0], "utf8");
    expect(note).toContain("- [ ] Подключить форму заявки на лендинге — Иван 📅 2026-11-13");
    expect(note).toContain("[[2026-11-02 Старт]]");
    expect(note).toContain('series: "Планёрка"');
    expect(saveToObsidian(m, { vault: join(vault, "нет") }).failed).toHaveLength(1);
    expect(toObsidian({ transcript })).toContain("# Встреча");
  });
  it("ключи новых сервисов — в списке шифруемых и в настройках не теряются", () => {
    saveConfig({ kaiten: { domain: "a.kaiten.ru", token: "enc:xx", boardId: "1", columnId: "2" } });
    saveConfig({ kaiten: { boardId: "3" } as any });
    const raw = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
    expect(raw.kaiten).toMatchObject({ token: "enc:xx", boardId: "3", domain: "a.kaiten.ru" });
  });
});

describe("подсказка о начале встречи на macOS", () => {
  it("Zoom во время встречи узнаётся по процессу CptHost", () => expect(macMeeting("launchd\nzoom.us\nCptHost", false)).toBe("Zoom"));
  it("микрофон свободен — молчим", () => expect(macMeeting("Telegram\nGoogle Chrome", false)).toBe(""));
  it("микрофон занят: одно приложение — называем, несколько — не гадаем", () => {
    expect(macMeeting("Finder\nTelegram", true)).toBe("Telegram");
    expect(macMeeting("Telegram\nGoogle Chrome", true)).toBe(CALL);
  });
  it("в main.mjs подсказка не срабатывает во время своей записи", () => {
    const main = readFileSync(join(__dirname, "../app/main.mjs"), "utf8");
    expect(main).toMatch(/if \(appState\.recording\) return;/);
    expect(existsSync(join(__dirname, "../app/recctl.mjs"))).toBe(true);
  });
});
