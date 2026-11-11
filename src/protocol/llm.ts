// Языковые модели для протокола.
// По умолчанию — локальная модель через llama.cpp: ничего не уходит в сеть.
// Облачная модель (OpenAI-совместимый API: YandexGPT, OpenRouter, свой сервер) — только если пользователь включил её сам.
import { netFetch } from "../net.js";
import { getModel, loadLocalLLM } from "@kozhevnikovai/local-ai";
import { missing, modelPath, PACKS, selectLlm } from "../models.js";

export interface LLM {
  name: string;
  /** Ответ строго по JSON-схеме */
  json<T>(system: string, user: string, schema: object, maxTokens?: number): Promise<T>;
  dispose(): Promise<void>;
}

export interface LLMOptions {
  provider?: "local" | "openai";
  /** Модель из каталога: qwen3-4b, qwen3-14b (local) */
  localModel?: string;
  /** Путь к своей GGUF-модели (local) */
  modelFile?: string;
  /** Размер контекста, токенов (local) */
  contextSize?: number;
  /** OpenAI-совместимый API */
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  /** "auto" | "cpu" | "cuda" | "vulkan" | "metal" */
  gpu?: string;
}

export async function createLLM(o: LLMOptions = {}): Promise<LLM> {
  return o.provider === "openai" ? openai(o) : local(o);
}

async function local(o: LLMOptions): Promise<LLM> {
  const id = selectLlm(o.localModel);
  const file = o.modelFile ?? modelPath(PACKS.llm.files[0].path);
  if (!o.modelFile && missing(["llm"]).length) throw new Error("Нет языковой модели. Запустите: protokolist models");
  const gpu = o.gpu ?? process.env.PROTOKOLIST_GPU ?? "auto";
  const m = await loadLocalLLM({ modelFile: file, gpu, contextSize: o.contextSize ?? 12288 });
  return { name: o.modelFile ? m.name : `${getModel(id).title} · ${m.device}`, json: m.json, dispose: m.dispose };
}

function openai(o: LLMOptions): LLM {
  if (!o.baseUrl || !o.model) throw new Error("Для облачной модели нужны адрес API и название модели");
  const url = o.baseUrl.replace(/\/$/, "") + "/chat/completions";
  return {
    name: `${o.model} · облако (${new URL(url).host})`,
    async json<T>(system: string, user: string, schema: object, maxTokens = 3000) {
      const body = JSON.stringify({
        model: o.model, temperature: 0.1, max_tokens: maxTokens,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: `${system}\n\nОтветь только JSON по схеме:\n${JSON.stringify(schema)}` },
          { role: "user", content: user },
        ],
      });
      const res = await netFetch("cloud-llm", url, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${o.apiKey ?? ""}` }, body });
      if (!res.ok) throw new Error(`Облачная модель ответила ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const data: any = await res.json();
      const text: string = data.choices?.[0]?.message?.content ?? "";
      const m = text.match(/\{[\s\S]*\}/);
      if (!m) throw new Error("Облачная модель вернула не JSON");
      return JSON.parse(m[0]) as T;
    },
    async dispose() {},
  };
}
