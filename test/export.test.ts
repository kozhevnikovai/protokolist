import { describe, expect, it, vi, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSZip from "jszip";
import { toHtml } from "../src/export/html.js";
import { toDocx } from "../src/export/docx.js";
import { toIcs, toMarkdown, toSrt } from "../src/export/text.js";
import { searchMeetings, listMeetings } from "../src/archive.js";
import { sendToBitrix24, sendToTelegram, sendToYouGile } from "../src/integrations/index.js";
import { netStats, setOffline } from "../src/net.js";
import { analyze } from "../src/analytics.js";
import { protocol, transcript } from "./fixtures/meeting.js";

const m = { transcript, protocol, analytics: analyze(transcript) };

describe("форматы", () => {
  it("Markdown: решения, задачи с датами, стенограмма", () => {
    const md = toMarkdown(m);
    expect(md).toContain("| 1 | Подключить форму заявки на лендинге | Иван | 13.11.2026 | 00:13 |");
    expect(md).toContain("## Стенограмма");
    expect(md).toContain("**[01:09] Я:**");
  });
  it("HTML: один файл, шрифты встроены, тайм-коды, штамп", () => {
    const h = toHtml(m);
    expect(h).toContain("font/woff2;base64");
    expect(h).toContain('data-t="69.8"');
    expect(h).toContain("0 байт в сеть");
    expect(h).toContain("<b>№ 003</b>");
    expect(h).not.toMatch(/https?:\/\/(fonts|cdn)/);
  });
  it("HTML честно помечает облачную модель", () => expect(toHtml(m, { sentBytes: 100 })).toContain("облачной моделью"));
  it("DOCX деловой и по ГОСТ", async () => {
    const text = async (b: Buffer) => (await (await JSZip.loadAsync(b)).file("word/document.xml")!.async("string")).replace(/<[^>]+>/g, "");
    const biz = await text(await toDocx(m));
    expect(biz).toContain("Подключить форму заявки");
    const g = await text(await toDocx({ ...m, protocol: { ...protocol, template: "gost" } }, { organization: "ООО «Ромашка»", chair: "Кожевников Е.", withTranscript: true }));
    for (const s of ["ПРОТОКОЛ", "ООО «Ромашка»", "ПОВЕСТКА ДНЯ", "СЛУШАЛИ", "РЕШИЛИ", "Утвердить тестовый бюджет", "Председатель", "Стенограмма"]) expect(g).toContain(s);
  });
  it("ICS: события в дни сроков", () => {
    const ics = toIcs(protocol);
    expect(ics).toContain("DTSTART;VALUE=DATE:20261113");
    expect(ics.match(/BEGIN:VEVENT/g)?.length).toBe(2);
  });
  it("SRT", () => expect(toSrt(transcript)).toContain("00:01:09,800 --> 00:01:30,000\nЯ: Хорошо"));
});

describe("архив и поиск", () => {
  const root = mkdtempSync(join(tmpdir(), "pk-"));
  mkdirSync(join(root, "2026-11-09 Запуск"));
  writeFileSync(join(root, "2026-11-09 Запуск", "встреча.json"), JSON.stringify(m));
  it("список", () => expect(listMeetings(root)[0]).toMatchObject({ title: "Запуск лендинга и реклама", tasks: 2 }));
  it("поиск по задачам и стенограмме", () => {
    const h = searchMeetings(root, "бюджет");
    expect(h[0].where).toBe("решение");
    expect(h.some(x => x.where === "стенограмма")).toBe(true);
    expect(searchMeetings(root, "Иван форма")[0].where).toBe("задача");
  });
});

describe("интеграции и сетевой учёт", () => {
  afterEach(() => { vi.unstubAllGlobals(); setOffline(false); });
  it("строгий офлайн блокирует отправку", async () => {
    setOffline(true);
    const r = await sendToYouGile(protocol, { key: "k", columnId: "c" });
    expect(r.ok).toBe(0);
    expect(r.failed[0].error).toContain("офлайн");
  });
  it("Битрикс24: задачи с ответственным и сроком", async () => {
    const calls: any[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: any) => {
      const body = JSON.parse(init.body);
      calls.push({ url, body });
      if (url.includes("user.search")) return new Response(JSON.stringify({ result: body.FIND === "Иван" ? [{ ID: "7", NAME: "Иван", LAST_NAME: "Петров" }] : [] }));
      return new Response(JSON.stringify({ result: { task: { id: 100 } } }));
    }));
    const r = await sendToBitrix24(protocol, { webhook: "https://x.bitrix24.ru/rest/1/abc/", users: { "Ольга Смирнова": 9 } });
    expect(r.ok).toBe(2);
    const adds = calls.filter(c => c.url.endsWith("tasks.task.add.json")).map(c => c.body.fields);
    expect(adds[0]).toMatchObject({ RESPONSIBLE_ID: 7, DEADLINE: "2026-11-13T18:00:00" });
    expect(adds[1].RESPONSIBLE_ID).toBe(9);
    expect(netStats().sentBytes).toBeGreaterThan(0);
  });
  it("YouGile и Telegram", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      urls.push(url);
      if (url.includes("/users")) return new Response(JSON.stringify({ content: [{ id: "u1", realName: "Иван Петров" }] }));
      return new Response(JSON.stringify({ ok: true, id: "t" }));
    }));
    expect((await sendToYouGile(protocol, { key: "k", columnId: "c" })).ok).toBe(2);
    expect((await sendToTelegram(protocol, { token: "T", chatId: "1" }, [{ name: "п.docx", data: Buffer.from("x"), mime: "application/octet-stream" }])).ok).toBe(2);
    expect(urls.filter(u => u.includes("api.telegram.org")).length).toBe(2);
  });
});
