// Настройки пользователя: один JSON в домашней папке Протоколиста. Ключи интеграций хранятся только здесь, на диске.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Bitrix24Config, TelegramConfig, YouGileConfig } from "./integrations/index.js";
import { homeDir } from "./models.js";
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

const file = () => join(homeDir(), "config.json");

export function loadConfig(): Config {
  try {
    const c = existsSync(file()) ? JSON.parse(readFileSync(file(), "utf8")) : {};
    return { ...DEFAULTS, ...c, llm: { ...DEFAULTS.llm, ...c.llm }, gost: { ...c.gost }, outputDir: c.outputDir || process.env.PROTOKOLIST_OUT || defaultOutputDir() };
  } catch { return { ...DEFAULTS, outputDir: process.env.PROTOKOLIST_OUT || defaultOutputDir() }; }
}

export function saveConfig(c: Partial<Config>): Config {
  const next = { ...loadConfig(), ...c };
  mkdirSync(homeDir(), { recursive: true });
  writeFileSync(file(), JSON.stringify(next, null, 2));
  return next;
}
