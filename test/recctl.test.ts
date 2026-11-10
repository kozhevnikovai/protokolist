import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
// @ts-expect-error — модуль приложения на чистом JS
import * as rc from "../app/recctl.mjs";

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

describe("Заметность записи: трей, индикатор, горячая клавиша", () => {
  it("время записи: 0, минуты, часы; мусор не ломает", () => {
    expect(rc.fmtElapsed(0)).toBe("00:00");
    expect(rc.fmtElapsed(65_000)).toBe("01:05");
    expect(rc.fmtElapsed(3_725_000)).toBe("1:02:05");
    expect(rc.fmtElapsed(-5)).toBe("00:00");
    expect(rc.fmtElapsed(NaN)).toBe("00:00");
  });
  it("подсказка трея говорит, что идёт запись", () => {
    expect(rc.trayTooltip({ recording: true, since: 0 }, 61_000)).toBe("Протоколист — идёт запись 01:01");
    expect(rc.trayTooltip({ recording: false, busy: true })).toMatch(/обрабатываю/);
  });
  it("меню трея: во время обработки новую запись не начать", () => {
    const busy = rc.trayItems({ recording: false, busy: true }, "win32");
    expect(busy[0]).toMatchObject({ id: "toggle", enabled: false });
    expect(rc.trayItems({ recording: true }, "win32")[0].label).toMatch(/Остановить.*Ctrl\+Alt\+R/);
    expect(rc.trayItems({ recording: false }, "darwin")[0].label).toMatch(/⌘⌥R/);
  });
  it("горячая клавиша не совпадает с Ctrl+Shift+R браузеров", () => {
    expect(rc.HOTKEY).toBe("CommandOrControl+Alt+R");
  });
  it("переключение: запись → стоп, обработка → ничего, иначе старт", () => {
    expect(rc.toggleAction({ recording: true, busy: true })).toBe("stop");
    expect(rc.toggleAction({ recording: false, busy: true })).toBe("none");
    expect(rc.toggleAction({ recording: false, busy: false })).toBe("start");
  });
  it("индикатор — в правом верхнем углу и не вылезает за маленький экран", () => {
    expect(rc.indicatorBounds({ x: 0, y: 0, width: 1920, height: 1040 })).toEqual({ x: 1656, y: 16, width: 248, height: 44 });
    const b = rc.indicatorBounds({ x: -1280, y: 0, width: 200, height: 30 });
    expect(b.x).toBe(-1280);
    expect(b.y).toBe(0);
  });
});

describe("Атаки на управление записью", () => {
  it("состояние из интерфейса: принимаются только булевы поля, время начала ставит главный процесс", () => {
    const s1 = rc.nextState({ recording: false, busy: false, since: null }, { recording: true, since: 1, evil: "x" }, 5000);
    expect(s1).toEqual({ recording: true, busy: false, since: 5000 });
    const s2 = rc.nextState(s1, { recording: "yes", busy: 1 }, 9000);
    expect(s2).toEqual(s1);
    expect(rc.nextState(s1, null, 9000)).toEqual(s1);
    expect(rc.nextState(s1, { recording: false }, 9000).since).toBeNull();
  });
  it("повторное «запись идёт» не сбрасывает таймер", () => {
    const s1 = rc.nextState({ recording: false, busy: false, since: null }, { recording: true }, 1000);
    expect(rc.nextState(s1, { recording: true }, 8000).since).toBe(1000);
  });
  it("команды индикатора — только из белого списка", () => {
    for (const bad of ["quit", "open", "__proto__", "toString", "", null, undefined, 1, {}, ["toggle"]]) expect(rc.isCommand(bad)).toBe(false);
    expect(rc.isCommand("toggle")).toBe(true);
    expect(rc.isCommand("show")).toBe(true);
  });
  it("главный процесс принимает команды только от окна индикатора, состояние — только от главного окна", () => {
    const main = read("app/main.mjs");
    expect(main).toMatch(/ipcMain\.on\("indicator-command", \(e, c\) => \{ if \(indicator && e\.sender === indicator\.webContents\) runCommand\(c\)/);
    expect(main).toMatch(/ipcMain\.handle\("state", \(e, st\) => \{\s*if \(e\.sender !== win\?\.webContents\) return;/);
  });
  it("индикатор изолирован: без Node, со строгой CSP, мост из двух методов", () => {
    const main = read("app/main.mjs");
    expect(main).toMatch(/indicator-preload\.cjs"\), contextIsolation: true, sandbox: true/);
    expect(read("app/ui/indicator.html")).toMatch(/default-src 'none'; script-src 'self'/);
    const pre = read("app/indicator-preload.cjs");
    expect(pre.match(/^\s+\w+: /gm)).toHaveLength(2);
  });
  it("индикатор не крадёт фокус и виден поверх полноэкранных окон", () => {
    const main = read("app/main.mjs");
    expect(main).toContain("focusable: false");
    expect(main).toContain('setAlwaysOnTop(true, "screen-saver")');
    expect(main).toContain("showInactive()");
  });
});
