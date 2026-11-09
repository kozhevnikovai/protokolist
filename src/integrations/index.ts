// Интеграции: задачи в Битрикс24 и YouGile, протокол в Telegram.
// Это единственные места, где данные встречи покидают компьютер, — только по явной настройке пользователя.
import { netFetch } from "../net.js";
import type { Protocol, Task } from "../types.js";

export interface SendResult { target: string; ok: number; failed: { task: string; error: string }[]; links: string[] }

const describe = (t: Task, p: Protocol) =>
  `${t.text}\n\nИз встречи «${p.title}» (${p.date}).${t.quote ? `\nЦитата: «${t.quote}»` : ""}${t.dueText && !t.due ? `\nСрок со слов: ${t.dueText}` : ""}\n\nСоздано Протоколистом`;

const nameMatch = (owner: string, full: string) => {
  const o = owner.toLowerCase().replace(/ё/g, "е").split(/\s+/).filter(w => w.length > 1);
  const f = full.toLowerCase().replace(/ё/g, "е");
  return o.length > 0 && o.every(w => f.includes(w.replace(/[ау]$/, "")));
};

// ── Битрикс24: входящий вебхук с правом «Задачи» (task) и «Пользователи» (user)
export interface Bitrix24Config {
  /** https://ваш-портал.bitrix24.ru/rest/1/код/ */
  webhook: string;
  /** Явное соответствие имён и ID: { "Иван": 12 } */
  users?: Record<string, number>;
  /** ID ответственного по умолчанию; иначе — владелец вебхука */
  defaultResponsible?: number;
}

export async function sendToBitrix24(p: Protocol, c: Bitrix24Config): Promise<SendResult> {
  const bad = validateBitrixWebhook(c.webhook);
  if (bad) return { target: "Битрикс24", ok: 0, failed: [{ task: "подключение", error: bad }], links: [] };
  const base = c.webhook.replace(/\/?$/, "/");
  const owner = c.defaultResponsible ?? Number(base.match(/\/rest\/(\d+)\//)?.[1] ?? 1);
  const call = async (method: string, body: object) => {
    const r = await netFetch("integration", `${base}${method}.json`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const j: any = await r.json().catch(() => ({}));
    if (!r.ok || j.error) throw new Error(j.error_description || j.error || `HTTP ${r.status}`);
    return j.result;
  };
  const res: SendResult = { target: "Битрикс24", ok: 0, failed: [], links: [] };
  const cache = new Map<string, number>();
  for (const t of p.tasks) {
    try {
      let rid = owner;
      if (t.owner) {
        const known = Object.entries(c.users ?? {}).find(([n]) => nameMatch(t.owner, n) || nameMatch(n, t.owner));
        if (known) rid = known[1];
        else if (cache.has(t.owner)) rid = cache.get(t.owner)!;
        else {
          const found: any[] = await call("user.search", { FIND: t.owner.split(/\s+/)[0] }).catch(() => []);
          const u = found.find(x => nameMatch(t.owner, `${x.NAME} ${x.LAST_NAME}`)) ?? (found.length === 1 ? found[0] : null);
          if (u) rid = Number(u.ID);
          cache.set(t.owner, rid);
        }
      }
      const r = await call("tasks.task.add", { fields: { TITLE: t.text.slice(0, 250), DESCRIPTION: describe(t, p), RESPONSIBLE_ID: rid, ...(t.due ? { DEADLINE: `${t.due}T18:00:00` } : {}) } });
      res.ok++;
      const id = r?.task?.id;
      if (id) res.links.push(`${base.replace(/\/rest\/.*$/, "")}/company/personal/user/${rid}/tasks/task/view/${id}/`);
    } catch (e: any) { res.failed.push({ task: t.text, error: friendly(e) }); }
  }
  return res;
}

// ── YouGile: ключ API (Настройки компании → API) и ID колонки, куда класть задачи
export interface YouGileConfig { key: string; columnId: string; baseUrl?: string }

export async function sendToYouGile(p: Protocol, c: YouGileConfig): Promise<SendResult> {
  const base = (c.baseUrl ?? "https://ru.yougile.com").replace(/\/$/, "") + "/api-v2";
  const H = { "content-type": "application/json", authorization: `Bearer ${c.key}` };
  const res: SendResult = { target: "YouGile", ok: 0, failed: [], links: [] };
  let users: { id: string; realName?: string; email?: string }[] = [];
  try {
    const r = await netFetch("integration", `${base}/users?limit=1000`, { headers: H });
    if (r.ok) users = ((await r.json()) as any).content ?? [];
  } catch { /* без пользователей — задачи без исполнителя */ }
  for (const t of p.tasks) {
    try {
      const u = t.owner ? users.find(x => x.realName && nameMatch(t.owner, x.realName)) : undefined;
      const body = { title: t.text.slice(0, 250), columnId: c.columnId, description: describe(t, p).replace(/\n/g, "<br>"), ...(u ? { assigned: [u.id] } : {}), ...(t.due ? { deadline: { deadline: new Date(`${t.due}T18:00:00`).getTime(), withTime: false } } : {}) };
      const r = await netFetch("integration", `${base}/tasks`, { method: "POST", headers: H, body: JSON.stringify(body) });
      if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
      res.ok++;
    } catch (e: any) { res.failed.push({ task: t.text, error: friendly(e) }); }
  }
  return res;
}

// ── Telegram: бот от @BotFather; chatId — ваш чат или группа (бот должен быть добавлен)
export interface TelegramConfig { token: string; chatId: string }

export async function sendToTelegram(p: Protocol, c: TelegramConfig, files: { name: string; data: Buffer; mime: string }[] = []): Promise<SendResult> {
  const api = `https://api.telegram.org/bot${c.token}`;
  const esc = (s: string) => s.replace(/[&<>]/g, x => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[x]!);
  const lines = [`<b>${esc(p.title)}</b> · ${p.date}`, "", esc(p.summary)];
  if (p.decisions.length) lines.push("", "<b>Решения</b>", ...p.decisions.map((d, i) => `${i + 1}. ${esc(d.text)}`));
  if (p.tasks.length) lines.push("", "<b>Задачи</b>", ...p.tasks.map(t => `• ${esc(t.text)} — ${esc(t.owner || "?")}${t.due ? `, до ${t.due.split("-").reverse().join(".")}` : t.dueText ? `, ${esc(t.dueText)}` : ""}`));
  const res: SendResult = { target: "Telegram", ok: 0, failed: [], links: [] };
  const text = lines.join("\n").slice(0, 4000);
  try {
    const r = await netFetch("integration", `${api}/sendMessage`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chat_id: c.chatId, text, parse_mode: "HTML" }) });
    const j: any = await r.json();
    if (!j.ok) throw new Error(j.description);
    res.ok++;
    for (const f of files) {
      const fd = new FormData();
      fd.append("chat_id", c.chatId);
      fd.append("document", new Blob([new Uint8Array(f.data)], { type: f.mime }), f.name);
      const rr: any = await (await netFetch("integration", `${api}/sendDocument`, { method: "POST", body: fd })).json();
      if (!rr.ok) throw new Error(rr.description);
      res.ok++;
    }
  } catch (e: any) { res.failed.push({ task: "сообщение", error: friendly(e) }); }
  return res;
}

// ── Проверка подключений: кнопка «Проверить» в настройках. Ничего из встреч не отправляет.
export interface CheckResult { ok: boolean; message: string }

/** Вебхук Битрикс24: только https и только адрес портала, не локальная сеть */
export function validateBitrixWebhook(url: string): string | null {
  let u: URL;
  try { u = new URL(url); } catch { return "Это не адрес. Скопируйте вебхук целиком: https://ваш-портал.bitrix24.ru/rest/1/код/"; }
  if (u.protocol !== "https:") return "Вебхук должен начинаться с https://";
  if (/^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.|\[?::1\]?$)|^172\.(1[6-9]|2\d|3[01])\./i.test(u.hostname)) return "Адрес в локальной сети не подходит — нужен адрес вашего портала Битрикс24";
  if (!/\/rest\/\d+\/[^/]+\/?$/.test(u.pathname)) return "Похоже на неполный вебхук: в конце должно быть /rest/номер/код/";
  return null;
}

export function friendly(e: unknown): string {
  const m = (e as Error)?.message ?? String(e);
  const cause = (e as any)?.cause?.code ?? "";
  if (/TimeoutError|aborted/i.test((e as any)?.name ?? "") || /timeout/i.test(m)) return "Сервис не ответил за 20 секунд — проверьте интернет";
  if (/ENOTFOUND|EAI_AGAIN/.test(cause)) return "Адрес не найден — проверьте, что он скопирован правильно, и интернет";
  if (/ECONNREFUSED|ECONNRESET|fetch failed/.test(cause + m)) return "Нет соединения с сервисом — проверьте интернет";
  return m;
}

export async function checkBitrix24(c: Bitrix24Config): Promise<CheckResult> {
  const bad = validateBitrixWebhook(c.webhook ?? "");
  if (bad) return { ok: false, message: bad };
  try {
    const r = await netFetch("integration", `${c.webhook.replace(/\/?$/, "/")}profile.json`, { method: "POST" });
    const j: any = await r.json().catch(() => ({}));
    if (j.error) return { ok: false, message: j.error === "insufficient_scope" ? "У вебхука нет нужных прав: включите «Задачи» и «Пользователи»" : j.error === "expired_token" || r.status === 401 ? "Вебхук недействителен — создайте новый" : j.error_description || j.error };
    if (!r.ok) return { ok: false, message: `Портал ответил HTTP ${r.status}` };
    return { ok: true, message: `Подключено: ${[j.result?.NAME, j.result?.LAST_NAME].filter(Boolean).join(" ") || "портал отвечает"}` };
  } catch (e) { return { ok: false, message: friendly(e) }; }
}

export async function checkYouGile(c: YouGileConfig): Promise<CheckResult> {
  if (!c.key) return { ok: false, message: "Вставьте ключ API" };
  if (!c.columnId) return { ok: false, message: "Укажите ID колонки, куда класть задачи" };
  const base = (c.baseUrl ?? "https://ru.yougile.com").replace(/\/$/, "") + "/api-v2";
  try {
    const r = await netFetch("integration", `${base}/columns/${encodeURIComponent(c.columnId)}`, { headers: { authorization: `Bearer ${c.key}` } });
    if (r.status === 401 || r.status === 403) return { ok: false, message: "Ключ не подходит — создайте новый в YouGile" };
    if (r.status === 404) return { ok: false, message: "Колонка с таким ID не найдена" };
    if (!r.ok) return { ok: false, message: `YouGile ответил HTTP ${r.status}` };
    const j: any = await r.json().catch(() => ({}));
    return { ok: true, message: `Подключено: колонка «${j.title ?? c.columnId}»` };
  } catch (e) { return { ok: false, message: friendly(e) }; }
}

export async function checkTelegram(c: TelegramConfig): Promise<CheckResult> {
  if (!/^\d+:[\w-]{30,}$/.test(c.token ?? "")) return { ok: false, message: "Токен выглядит неверно. Он выглядит так: 123456789:AAE…" };
  const api = `https://api.telegram.org/bot${c.token}`;
  try {
    const me: any = await (await netFetch("integration", `${api}/getMe`)).json();
    if (!me.ok) return { ok: false, message: "Telegram не принял токен — проверьте его у @BotFather" };
    if (!c.chatId) return { ok: false, message: `Бот @${me.result.username} найден. Теперь укажите ID чата` };
    const ch: any = await (await netFetch("integration", `${api}/getChat?chat_id=${encodeURIComponent(c.chatId)}`)).json();
    if (!ch.ok) return { ok: false, message: `Бот @${me.result.username} не видит этот чат. Напишите боту /start или добавьте его в группу` };
    return { ok: true, message: `Подключено: @${me.result.username} → ${ch.result.title ?? ch.result.first_name ?? c.chatId}` };
  } catch (e) { return { ok: false, message: friendly(e) }; }
}
