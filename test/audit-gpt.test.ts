// Регрессии по независимому аудиту: архив не теряет встречи, пути не выходят за папку протоколов.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const home = mkdtempSync(join(tmpdir(), "pk-audit-"));
process.env.PROTOKOLIST_HOME = home;
const { brokenMeetings, listMeetings, searchMeetings } = await import("../src/archive.js");
const { loadConfig, saveConfig } = await import("../src/config.js");
const { finish, newMeetingDir, safeDate } = await import("../src/pipeline.js");
const { transcript } = await import("./fixtures/meeting.js");

const cfg = () => { const out = mkdtempSync(join(tmpdir(), "pk-out-")); saveConfig({ outputDir: out }); return { ...loadConfig(), outputDir: out }; };

describe("архив встреч", () => {
  it("две встречи с одной датой и названием не перезаписывают друг друга", async () => {
    const c = cfg();
    const a = await finish({ ...transcript, source: "Планёрка.m4a", segments: transcript.segments.slice(0, 2) }, null, { config: c, noProtocol: true, formats: ["json"] });
    const b = await finish({ ...transcript, source: "Планёрка.m4a", segments: transcript.segments.slice(2, 4) }, null, { config: c, noProtocol: true, formats: ["json"] });
    expect(a.dir).not.toBe(b.dir);
    expect(b.dir.endsWith("(2)")).toBe(true);
    expect(listMeetings(c.outputDir)).toHaveLength(2);
    expect(JSON.parse(readFileSync(join(a.dir, "встреча.json"), "utf8")).transcript.segments[0].text).toBe(transcript.segments[0].text);
  });
  it("дата из чужой стенограммы не выводит за папку протоколов", async () => {
    expect(safeDate("../../evil")).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const c = cfg();
    const r = await finish({ ...transcript, date: "../../../tmp/x" }, null, { config: c, noProtocol: true, formats: ["json"] });
    expect(r.dir.startsWith(c.outputDir)).toBe(true);
    expect(() => newMeetingDir(c.outputDir, "2026-11-18", "..")).not.toThrow();
  });
  it("повреждённый встреча.json не ломает список, поиск и задачи", async () => {
    const c = cfg();
    await finish(transcript, null, { config: c, noProtocol: true, formats: ["json"] });
    mkdirSync(join(c.outputDir, "2026-01-01 сломанная"));
    writeFileSync(join(c.outputDir, "2026-01-01 сломанная", "встреча.json"), "{ не json");
    expect(listMeetings(c.outputDir)).toHaveLength(1);
    expect(brokenMeetings(c.outputDir)).toEqual(["2026-01-01 сломанная"]);
    expect(() => searchMeetings(c.outputDir, "что угодно")).not.toThrow();
  });
  it.skipIf(process.platform === "win32")("ссылка на папку вне архива не попадает в список", async () => {
    const c = cfg();
    const outside = mkdtempSync(join(tmpdir(), "pk-outside-"));
    writeFileSync(join(outside, "встреча.json"), JSON.stringify({ transcript: { ...transcript, source: "чужое" } }));
    symlinkSync(outside, join(c.outputDir, "2026-01-02 ссылка"));
    expect(listMeetings(c.outputDir).some(m => m.title === "чужое")).toBe(false);
    expect(existsSync(join(outside, "встреча.json"))).toBe(true);
  });
});
