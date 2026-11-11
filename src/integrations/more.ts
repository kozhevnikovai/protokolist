// Подключения 1.2: Kaiten, Яндекс Трекер, Пачка — по сети и только по кнопке; Obsidian — заметка в папку хранилища, без сети.
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Meeting } from "../export/text.js";
import { netFetch } from "../net.js";
import type { Protocol, Task } from "../types.js";
import { type CheckResult, friendly, type SendResult } from "./index.js";

const describe = (t: Task, p: Protocol) =>
  `${t.text}\n\nИз встречи «${p.title}» (${p.date}).${t.owner ? `\nОтветственный со слов: ${t.owner}` : ""}${t.quote ? `\nЦитата: «${t.quote}»` : ""}${t.dueText && !t.due ? `\nСрок со слов: ${t.dueText}` : ""}\n\nСоздано Протоколистом`;
const PRIVATE = /^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.|\[?::1\]?$)|^172\.(1[6-9]|2\d|3[01])\./i;

// ── Kaiten: Профиль → API-ключи; доска и колонка — ID из адреса доски
export interface KaitenConfig { domain: string; token: string; boardId: string; columnId: string }

/** Адрес Kaiten: «company.kaiten.ru» или https://… ; только https и не локальная сеть */
export function kaitenBase(domain: string): string | null {
  const d = (domain ?? "").trim().replace(/\/+$/, "");
  let u: URL;
  try { u = new URL(/^https?:\/\//i.test(d) ? d : `https://${d}`); } catch { return null; }
  if (u.protocol !== "https:" || PRIVATE.test(u.hostname) || !u.hostname.includes(".")) return null;
  return `https://${u.host}`;
}

export async function sendToKaiten(p: Protocol, c: KaitenConfig): Promise<SendResult> {
  const res: SendResult = { target: "Kaiten", ok: 0, failed: [], links: [] };
  const base = kaitenBase(c.domain);
  if (!base) return { ...res, failed: [{ task: "подключение", error: "Адрес Kaiten указан неверно: нужен вида company.kaiten.ru" }] };
  for (const t of p.tasks) {
    try {
      const body = { title: t.text.slice(0, 250), board_id: Number(c.boardId), column_id: Number(c.columnId), description: describe(t, p), ...(t.due ? { due_date: `${t.due}T15:00:00.000Z` } : {}) };
      const r = await netFetch("integration", `${base}/api/latest/cards`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${c.token}` }, body: JSON.stringify(body) });
      if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
      const j: any = await r.json().catch(() => ({}));
      res.ok++;
      if (j.id) res.links.push(`${base}/${j.id}`);
    } catch (e) { res.failed.push({ task: t.text, error: friendly(e) }); }
  }
  return res;
}

export async function checkKaiten(c: KaitenConfig): Promise<CheckResult> {
  const base = kaitenBase(c.domain);
  if (!base) return { ok: false, message: "Укажите адрес вашего Kaiten, например company.kaiten.ru" };
  if (!c.token) return { ok: false, message: "Вставьте API-ключ" };
  if (!/^\d+$/.test(c.boardId ?? "") || !/^\d+$/.test(c.columnId ?? "")) return { ok: false, message: "ID доски и колонки — числа из адреса доски" };
  try {
    const H = { authorization: `Bearer ${c.token}` };
    const me = await netFetch("integration", `${base}/api/latest/users/current`, { headers: H });
    if (me.status === 401 || me.status === 403) return { ok: false, message: "Ключ не подходит — создайте новый в профиле Kaiten" };
    if (!me.ok) return { ok: false, message: `Kaiten ответил HTTP ${me.status}` };
    const b = await netFetch("integration", `${base}/api/latest/boards/${c.boardId}`, { headers: H });
    if (!b.ok) return { ok: false, message: "Доска с таким ID не найдена или нет доступа" };
    const j: any = await b.json().catch(() => ({}));
    const col = (j.columns ?? []).find((x: any) => String(x.id) === String(c.columnId));
    if (j.columns && !col) return { ok: false, message: `На доске «${j.title ?? c.boardId}» нет колонки ${c.columnId}` };
    return { ok: true, message: `Подключено: доска «${j.title ?? c.boardId}»${col ? `, колонка «${col.title}»` : ""}` };
  } catch (e) { return { ok: false, message: friendly(e) }; }
}

// ── Яндекс Трекер: OAuth-токен, ID организации (Яндекс 360 или Cloud), ключ очереди
export interface TrackerConfig { token: string; orgId: string; cloud?: boolean; queue: string }
const TRACKER = "https://api.tracker.yandex.net/v3";
const trackerHeaders = (c: TrackerConfig) => ({ "content-type": "application/json", authorization: `OAuth ${c.token}`, [c.cloud ? "x-cloud-org-id" : "x-org-id"]: c.orgId });

export async function sendToTracker(p: Protocol, c: TrackerConfig): Promise<SendResult> {
  const res: SendResult = { target: "Яндекс Трекер", ok: 0, failed: [], links: [] };
  for (const t of p.tasks) {
    try {
      const body = { queue: c.queue.toUpperCase(), summary: t.text.slice(0, 250), description: describe(t, p), ...(t.due ? { deadline: t.due } : {}) };
      const r = await netFetch("integration", `${TRACKER}/issues/`, { method: "POST", headers: trackerHeaders(c), body: JSON.stringify(body) });
      if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
      const j: any = await r.json().catch(() => ({}));
      res.ok++;
      if (j.key) res.links.push(`https://tracker.yandex.ru/${j.key}`);
    } catch (e) { res.failed.push({ task: t.text, error: friendly(e) }); }
  }
  return res;
}

export async function checkTracker(c: TrackerConfig): Promise<CheckResult> {
  if (!c.token) return { ok: false, message: "Вставьте OAuth-токен" };
  if (!/^[\w-]+$/.test(c.orgId ?? "")) return { ok: false, message: "Укажите ID организации (Администрирование → Организации)" };
  if (!/^[A-Za-z][\w]*$/.test(c.queue ?? "")) return { ok: false, message: "Укажите ключ очереди латиницей, например SALES" };
  try {
    const me = await netFetch("integration", `${TRACKER}/myself`, { headers: trackerHeaders(c) });
    if (me.status === 401 || me.status === 403) return { ok: false, message: "Трекер не принял токен или ID организации — проверьте, что выбран верный тип (Яндекс 360 или Cloud)" };
    if (!me.ok) return { ok: false, message: `Трекер ответил HTTP ${me.status}` };
    const q = await netFetch("integration", `${TRACKER}/queues/${encodeURIComponent(c.queue.toUpperCase())}`, { headers: trackerHeaders(c) });
    if (!q.ok) return { ok: false, message: `Очередь ${c.queue.toUpperCase()} не найдена или нет доступа` };
    const j: any = await q.json().catch(() => ({}));
    return { ok: true, message: `Подключено: очередь «${j.name ?? c.queue.toUpperCase()}»` };
  } catch (e) { return { ok: false, message: friendly(e) }; }
}

// ── Пачка: токен (Автоматизации → API), ID чата из адреса беседы
export interface PachcaConfig { token: string; chatId: string }
const PACHCA = "https://api.pachca.com/api/shared/v1";

export function pachcaText(p: Protocol): string {
  const L = [`**${p.title}** · ${p.date}`, "", p.summary];
  if (p.decisions.length) L.push("", "**Решения**", ...p.decisions.map((d, i) => `${i + 1}. ${d.text}`));
  if (p.tasks.length) L.push("", "**Задачи**", ...p.tasks.map(t => `• ${t.text} — ${t.owner || "?"}${t.due ? `, до ${t.due.split("-").reverse().join(".")}` : t.dueText ? `, ${t.dueText}` : ""}`));
  let text = "";
  for (const l of L) { if (text.length + l.length + 1 > 3900) { text += "\n…"; break; } text += (text ? "\n" : "") + l; }
  return text;
}

export async function sendToPachca(p: Protocol, c: PachcaConfig): Promise<SendResult> {
  const res: SendResult = { target: "Пачка", ok: 0, failed: [], links: [] };
  try {
    const r = await netFetch("integration", `${PACHCA}/messages`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${c.token}` }, body: JSON.stringify({ message: { entity_type: "discussion", entity_id: Number(c.chatId), content: pachcaText(p) } }) });
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
    res.ok++;
  } catch (e) { res.failed.push({ task: "сообщение", error: friendly(e) }); }
  return res;
}

export async function checkPachca(c: PachcaConfig): Promise<CheckResult> {
  if (!c.token) return { ok: false, message: "Вставьте токен доступа" };
  if (!/^\d+$/.test(c.chatId ?? "")) return { ok: false, message: "ID чата — число из адреса беседы" };
  try {
    const r = await netFetch("integration", `${PACHCA}/chats/${c.chatId}`, { headers: { authorization: `Bearer ${c.token}` } });
    if (r.status === 401) return { ok: false, message: "Пачка не приняла токен" };
    if (r.status === 403 || r.status === 404) return { ok: false, message: "Чат не найден или бот в нём не состоит" };
    if (!r.ok) return { ok: false, message: `Пачка ответила HTTP ${r.status}` };
    const j: any = await r.json().catch(() => ({}));
    return { ok: true, message: `Подключено: «${j.data?.name ?? c.chatId}»` };
  } catch (e) { return { ok: false, message: friendly(e) }; }
}

// ── Obsidian: заметка встречи в папке хранилища. Задачи — в формате плагина Tasks (📅 срок). Сеть не нужна.
export interface ObsidianConfig { vault: string; folder?: string }
const fileSafe = (s: string) => s.replace(/[\\/:*?"<>|#^[\]]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80) || "встреча";
export const obsidianNoteName = (date: string, title: string) => `${date} ${fileSafe(title)}`;
const yaml = (s: string) => JSON.stringify(s);

export function toObsidian(m: Meeting): string {
  const { transcript: tr, protocol: p } = m;
  const title = p?.title ?? "Встреча";
  const L = ["---", `date: ${tr.date}`, `title: ${yaml(title)}`, ...(m.series ? [`series: ${yaml(m.series)}`] : []),
    `participants: [${tr.speakers.map(s => yaml(s.label)).join(", ")}]`, "tags: [встреча]", "---", "", `# ${title}`, ""];
  if (m.previous) L.push(`Прошлая встреча: [[${obsidianNoteName(m.previous.date, m.previous.title)}]]`, "");
  if (p?.summary) L.push(p.summary, "");
  if (p?.decisions.length) L.push("## Решения", "", ...p.decisions.map((d, i) => `${i + 1}. ${d.text}`), "");
  if (p?.tasks.length) L.push("## Задачи", "", ...p.tasks.map(t => `- [${t.done ? "x" : " "}] ${t.text}${t.owner ? ` — ${t.owner}` : ""}${t.due ? ` 📅 ${t.due}` : t.dueText ? ` (${t.dueText})` : ""}`), "");
  if (m.previous?.tasks.length) L.push("## С прошлой встречи", "", ...m.previous.tasks.map(t => `- [${t.status === "done" ? "x" : " "}] ${t.text}${t.owner ? ` — ${t.owner}` : ""}${t.status === "discussed" ? " (обсуждали)" : ""}`), "");
  if (p?.openQuestions.length) L.push("## Открытые вопросы", "", ...p.openQuestions.map(q => `- ${q}`), "");
  L.push("_Создано Протоколистом_", "");
  return L.join("\n");
}

export function saveToObsidian(m: Meeting, c: ObsidianConfig): SendResult {
  const res: SendResult = { target: "Obsidian", ok: 0, failed: [], links: [] };
  try {
    const vault = resolve(c.vault ?? "");
    if (!c.vault || !existsSync(vault) || !statSync(vault).isDirectory()) throw new Error("Папка хранилища Obsidian не найдена — выберите её в настройках");
    const sub = fileSafe(c.folder || "Встречи");
    const dir = join(vault, sub);
    mkdirSync(dir, { recursive: true });
    const f = join(dir, `${obsidianNoteName(m.transcript.date, m.protocol?.title ?? "Встреча")}.md`);
    writeFileSync(f, toObsidian(m));
    res.ok++;
    res.links.push(f);
  } catch (e) { res.failed.push({ task: "заметка", error: (e as Error).message }); }
  return res;
}

export async function checkObsidian(c: ObsidianConfig): Promise<CheckResult> {
  const vault = resolve(c.vault ?? "");
  if (!c.vault || !existsSync(vault) || !statSync(vault).isDirectory()) return { ok: false, message: "Выберите папку хранилища Obsidian" };
  return { ok: true, message: existsSync(join(vault, ".obsidian")) ? "Хранилище Obsidian найдено" : "Папка найдена (признаков Obsidian нет — заметки всё равно будут сохраняться сюда)" };
}
