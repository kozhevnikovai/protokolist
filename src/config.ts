// Настройки пользователя: один JSON в домашней папке Протоколиста.
// Ключи интеграций в приложении шифруются средствами ОС (Windows DPAPI, связка ключей macOS) — в файле лежит «enc:…».
// CLI и MCP-сервер берут ключи из переменных окружения или из незашифрованных значений, заданных через CLI.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Bitrix24Config, TelegramConfig, YouGileConfig } from "./integrations/index.js";
import { homeDir, selectLlm } from "./models.js";
import type { LLMOptions } from "./protocol/llm.js";

export interface Config {
  template: string;
  formats: string[];
  /** Строгий офлайн: интеграции и облачная модель заблокированы */
  offline: boolean;
  /** Удалять аудио после расшифровки */
  deleteAudio: boolean;
  /** Маскировать телефоны, почту, ИНН и т. п. в том, что уходит в интеграции */
  maskOnSend: boolean;
  llm: LLMOptions;
  /** Словарь компании: по строке на термин, варианты через «=» */
  glossary: string;
  /** Ставка, ₽/час — для стоимости встречи (0 — не считать) */
  hourlyRate: number;
  /** Папка с протоколами */
  outputDir: string;
  /** Реквизиты для протокола по ГОСТ */
  gost: { organization?: string; place?: string; chair?: string; secretary?: string };
  bitrix24?: Bitrix24Config;
  yougile?: YouGileConfig;
  telegram?: TelegramConfig;
}

export function defaultOutputDir(): string {
  const docs = process.env.USERPROFILE ? join(process.env.USERPROFILE, "Documents") : process.env.HOME ? join(process.env.HOME, "Documents") : homeDir();
  return join(docs, "Протоколист");
}

export const DEFAULTS: Config = {
  template: "planerka", formats: ["html", "docx", "md"], offline: true, deleteAudio: false, maskOnSend: true,
  llm: { provider: "local" }, glossary: "", hourlyRate: 0, outputDir: "", gost: {},
};

export const configFile = () => join(homeDir(), "config.json");
const file = configFile;

/** Поля с ключами и токенами */
export const SECRET_KEYS = ["bitrix24.webhook", "yougile.key", "telegram.token", "llm.apiKey"] as const;
const ENV: Record<string, string> = { "bitrix24.webhook": "PROTOKOLIST_BITRIX24_WEBHOOK", "yougile.key": "PROTOKOLIST_YOUGILE_KEY", "telegram.token": "PROTOKOLIST_TELEGRAM_TOKEN", "llm.apiKey": "PROTOKOLIST_LLM_KEY" };
let secrets: Record<string, string> = {};
/** Расшифрованные ключи от главного процесса приложения (только в памяти) */
export function setSecrets(s: Record<string, string> | undefined) { secrets = s ?? {}; }

export const getPath = (o: any, k: string) => k.split(".").reduce((a, x) => a?.[x], o);
export function setPath(o: any, k: string, v: unknown) {
  const ks = k.split(".");
  let cur = o;
  for (const x of ks.slice(0, -1)) cur = cur[x] ??= {};
  cur[ks.at(-1)!] = v;
}
function resolveSecrets(c: Config): Config {
  for (const k of SECRET_KEYS) {
    const v = getPath(c, k);
    const env = process.env[ENV[k]];
    if (env) setPath(c, k, env);
    else if (typeof v === "string" && v.startsWith("enc:")) setPath(c, k, secrets[k] ?? "");
  }
  return c;
}

export function loadConfig(): Config {
  try {
    const c = existsSync(file()) ? JSON.parse(readFileSync(file(), "utf8")) : {};
    selectLlm(c.llm?.localModel); // от выбранной модели зависят «каких файлов не хватает» и загрузка
    return resolveSecrets({ ...DEFAULTS, ...c, llm: { ...DEFAULTS.llm, ...c.llm }, gost: { ...c.gost }, bitrix24: c.bitrix24 && { ...c.bitrix24 }, yougile: c.yougile && { ...c.yougile }, telegram: c.telegram && { ...c.telegram }, outputDir: c.outputDir || process.env.PROTOKOLIST_OUT || defaultOutputDir() });
  } catch { return { ...DEFAULTS, outputDir: process.env.PROTOKOLIST_OUT || defaultOutputDir() }; }
}

/** Настройки как они лежат на диске (ключи — в зашифрованном виде) */
export function rawConfig(): any {
  try { return existsSync(file()) ? JSON.parse(readFileSync(file(), "utf8")) : {}; } catch { return {}; }
}

/** Сохраняет изменения. Ключи, не переданные в patch, не трогаются и не расшифровываются на диск. */
export function saveConfig(c: Partial<Config>): Config {
  const raw = rawConfig();
  const next: any = { ...raw, ...c };
  for (const g of ["llm", "gost", "bitrix24", "yougile", "telegram"] as const) if ((c as any)[g] && raw[g]) next[g] = { ...raw[g], ...(c as any)[g] };
  for (const k of SECRET_KEYS) if (getPath(c, k) === undefined && getPath(raw, k) !== undefined) setPath(next, k, getPath(raw, k));
  if (typeof next.hourlyRate === "number" && (!Number.isFinite(next.hourlyRate) || next.hourlyRate < 0)) next.hourlyRate = 0;
  if (Array.isArray(next.formats)) next.formats = [...new Set(next.formats.map((f: string) => String(f).toLowerCase().trim()).filter((f: string) => ["html", "docx", "md", "json", "txt", "srt", "ics"].includes(f)))];
  if (Array.isArray(next.formats) && !next.formats.length) next.formats = ["html"];
  mkdirSync(homeDir(), { recursive: true });
  writeFileSync(file(), JSON.stringify(next, null, 2));
  return loadConfig();
}
