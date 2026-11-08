// Маскирование персональных данных перед отправкой или пересылкой (152-ФЗ):
// телефоны, почта, номера карт, ИНН, СНИЛС, паспорт. Применяется к копии — оригинал не меняется.

const RULES: [RegExp, string][] = [
  [/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[почта]"],
  [/\b(?:\d[ -]?){15,18}\d\b/g, "[номер карты]"],
  [/\b\d{3}-\d{3}-\d{3}[ -]\d{2}\b/g, "[СНИЛС]"],
  [/(?<!\d)(?:\+7|8)[\s(-]*\d{3}[\s)-]*\d{3}[\s-]*\d{2}[\s-]*\d{2}(?!\d)/g, "[телефон]"],
  [/\b\d{2}\s?\d{2}\s\d{6}\b/g, "[паспорт]"],
  [/\b\d{12}\b|\b\d{10}\b/g, "[ИНН]"],
];

export function maskText(s: string): string {
  let out = s;
  for (const [re, label] of RULES) out = out.replace(re, label);
  return out;
}

/** Глубокое маскирование всех строк объекта (протокол, стенограмма) */
export function mask<T>(obj: T): T {
  if (typeof obj === "string") return maskText(obj) as T;
  if (Array.isArray(obj)) return obj.map(mask) as T;
  if (obj && typeof obj === "object") return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, mask(v)])) as T;
  return obj;
}
