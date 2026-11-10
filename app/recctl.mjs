// Заметность записи: значок в трее, индикатор «идёт запись» поверх всех окон, горячая клавиша.
// Чистые функции вынесены отдельно — их проверяют тесты без Electron.

/** Горячая клавиша записи: Ctrl+Alt+R (Windows) / ⌘⌥R (macOS). Не пересекается с Ctrl+Shift+R браузеров. */
export const HOTKEY = "CommandOrControl+Alt+R";
export function hotkeyLabel(platform) {
  return platform === "darwin" ? "⌘⌥R" : "Ctrl+Alt+R";
}

export function fmtElapsed(ms) {
  const s = Math.max(0, Math.floor((Number.isFinite(ms) ? ms : 0) / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  const p = n => String(n).padStart(2, "0");
  return h ? `${h}:${p(m)}:${p(x)}` : `${p(m)}:${p(x)}`;
}

/** Подсказка у значка в трее */
export function trayTooltip(st, now = Date.now()) {
  if (st.recording) return `Протоколист — идёт запись ${fmtElapsed(now - (st.since ?? now))}`;
  if (st.busy) return "Протоколист — обрабатываю встречу";
  return "Протоколист";
}

/** Пункты меню трея (без Electron: label, действие, доступность) */
export function trayItems(st, platform) {
  const key = hotkeyLabel(platform);
  return [
    st.recording
      ? { id: "toggle", label: `■ Остановить запись (${key})`, enabled: true }
      : { id: "toggle", label: `● Начать запись (${key})`, enabled: !st.busy },
    { id: "show", label: "Открыть Протоколист", enabled: true },
    { id: "quit", label: "Выйти", enabled: true },
  ];
}

export const INDICATOR = { width: 248, height: 44, margin: 16 };
/** Индикатор — в правом верхнем углу рабочей области основного экрана */
export function indicatorBounds(workArea) {
  const { width, height, margin } = INDICATOR;
  const x = Math.round(workArea.x + Math.max(0, workArea.width - width - margin));
  const y = Math.round(workArea.y + Math.min(margin, Math.max(0, workArea.height - height)));
  return { x, y, width, height };
}

/**
 * Состояние от интерфейса приходит через IPC — принимаем только два булевых поля.
 * Время начала записи ставит главный процесс, а не интерфейс.
 */
export function nextState(prev, patch, now = Date.now()) {
  const p = patch && typeof patch === "object" ? patch : {};
  const recording = typeof p.recording === "boolean" ? p.recording : !!prev.recording;
  const busy = typeof p.busy === "boolean" ? p.busy : !!prev.busy;
  const since = recording ? (prev.recording ? prev.since : now) : null;
  return { recording, busy, since };
}

/** Команды из индикатора и трея — только из белого списка */
export const COMMANDS = new Set(["toggle", "show"]);
export function isCommand(x) {
  return typeof x === "string" && COMMANDS.has(x);
}

/** Переключение по горячей клавише: во время обработки новую запись не начинаем */
export function toggleAction(st) {
  if (st.recording) return "stop";
  if (st.busy) return "none";
  return "start";
}
