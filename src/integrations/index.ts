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
    } catch (e: any) { res.failed.push({ task: t.text, error: e.message }); }
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
    } catch (e: any) { res.failed.push({ task: t.text, error: e.message }); }
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
  } catch (e: any) { res.failed.push({ task: "сообщение", error: e.message }); }
  return res;
}
