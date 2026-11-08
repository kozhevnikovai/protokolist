import { describe, expect, it } from "vitest";
import { parseDue } from "../src/protocol/dates.js";
import { applyGlossary, parseGlossary } from "../src/glossary.js";
import { maskText, mask } from "../src/privacy.js";
import { chunkTranscript, locateQuote } from "../src/protocol/build.js";
import { clusterVoices } from "../src/transcribe.js";
import { analyze } from "../src/analytics.js";
import { transcript, protocol } from "./fixtures/meeting.js";

describe("сроки из речи", () => {
  const d = "2026-11-09"; // понедельник
  it.each([
    ["до пятницы", "2026-11-13"], ["в среду", "2026-11-11"], ["завтра", "2026-11-10"], ["послезавтра", "2026-11-11"], ["сегодня", "2026-11-09"],
    ["к 15 ноября", "2026-11-15"], ["до 10 января", "2027-01-10"], ["20.11", "2026-11-20"], ["01.12.2026", "2026-12-01"],
    ["через неделю", "2026-11-16"], ["через 3 дня", "2026-11-12"], ["через две недели", "2026-11-23"], ["до конца месяца", "2026-11-30"],
    ["до конца недели", "2026-11-13"], ["на следующей неделе", "2026-11-20"], ["в следующий вторник", "2026-11-10"], ["2026-12-05", "2026-12-05"],
    ["к маю", null], ["когда сможешь", null], ["", null],
  ])("«%s» → %s", (text, want) => expect(parseDue(text as string, d)).toBe(want));
});

describe("словарь компании", () => {
  const g = parseGlossary("# комментарий\nБитрикс24 = битрикс двадцать четыре = битрикс 24\nКожевников\nYouGile = юджайл");
  it("точные варианты", () => expect(applyGlossary("Ставим задачи в битрикс двадцать четыре и юджайл.", g)).toBe("Ставим задачи в Битрикс24 и YouGile."));
  it("близкое написание", () => expect(applyGlossary("Спроси у Кожевникав, он знает.", g)).toBe("Спроси у Кожевников, он знает."));
  it("не трогает непохожее", () => expect(applyGlossary("Кожаный диван", g)).toBe("Кожаный диван"));
});

describe("маскирование ПДн", () => {
  it("телефон, почта, ИНН, карта", () => {
    expect(maskText("Звоните +7 916 123-45-67 или 8(495)1234567, пишите a.b@mail.ru")).toBe("Звоните [телефон] или [телефон], пишите [почта]");
    expect(maskText("ИНН 7707083893, карта 4276 1600 1234 5678")).toBe("ИНН [ИНН], карта [номер карты]");
  });
  it("глубоко по объекту", () => expect(mask({ a: ["тел. +79161234567"] }).a[0]).toBe("тел. [телефон]"));
});

describe("цитаты и тайм-коды", () => {
  it("находит дословную и близкую цитату", () => {
    expect(locateQuote(transcript, "Я подключу форму до пятницы")).toBe(13);
    expect(locateQuote(transcript, "утверждаем тестовый бюджет 50 тысяч")).toBe(69.8);
  });
  it("выдуманная цитата → null", () => expect(locateQuote(transcript, "переносим запуск на январь из-за отпуска")).toBeNull());
});

describe("нарезка стенограммы", () => {
  it("куски не длиннее лимита, с перекрытием", () => {
    const lines = Array.from({ length: 50 }, (_, i) => `[00:${i}] Спикер: реплика номер ${i} `.padEnd(100, "x"));
    const ch = chunkTranscript(lines, 1000);
    expect(ch.length).toBeGreaterThan(5);
    expect(ch.every(c => c.length <= 1300)).toBe(true);
    expect(ch[1].split("\n")[0]).toBe(ch[0].split("\n").at(-2));
  });
});

describe("кластеризация голосов", () => {
  const rnd = (seed: number) => () => ((seed = (seed * 16807) % 2147483647) / 2147483647) - 0.5;
  const unit = (v: number[]) => { const n = Math.hypot(...v); return v.map(x => x / n); };
  const r = rnd(42);
  const centers = [0, 1, 2].map(() => unit(Array.from({ length: 64 }, r)));
  const truth: number[] = [];
  const embs = Array.from({ length: 60 }, (_, i) => { const k = i % 3; truth.push(k); return unit(centers[k].map(x => x + r() * 0.08)); });
  const dur = embs.map((_, i) => (i % 7 === 0 ? 0.8 : 3));
  it("находит 3 голоса без подсказки", () => {
    const l = clusterVoices(embs, dur);
    expect(new Set(l).size).toBe(3);
    const map = new Map<number, number>();
    truth.forEach((t, i) => map.set(l[i], t));
    expect(truth.every((t, i) => map.get(l[i]) === t)).toBe(true);
  });
  it("слушается точного числа спикеров", () => expect(new Set(clusterVoices(embs, dur, { speakers: 2 })).size).toBe(2));
});

describe("аналитика", () => {
  it("доли, монолог, перебивания, стоимость", () => {
    const a = analyze(transcript, 3000);
    expect(a.talkShare[0]).toMatchObject({ speaker: "Иван", percent: 42 });
    expect(a.longestMonologue).toMatchObject({ speaker: "Иван", seconds: 34 });
    expect(a.cost).toBe(313);
    expect(protocol.tasks.length).toBe(2);
  });
});
