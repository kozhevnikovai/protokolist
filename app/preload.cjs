// Мост между интерфейсом и главным процессом: только перечисленные методы, без доступа к Node.
const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("pk", {
  core: (method, args) => ipcRenderer.invoke("core", method, args),
  pickFile: () => ipcRenderer.invoke("pick-file"),
  pickDir: () => ipcRenderer.invoke("pick-dir"),
  recChunk: (name, bytes) => ipcRenderer.invoke("rec-chunk", name, bytes),
  recPath: name => ipcRenderer.invoke("rec-path", name),
  recDone: paths => ipcRenderer.invoke("rec-done", paths),
  recOrphans: () => ipcRenderer.invoke("rec-orphans"),
  setState: st => ipcRenderer.invoke("state", st),
  version: () => ipcRenderer.invoke("version"),
  check: (target, cfg) => ipcRenderer.invoke("check", target, cfg),
  open: p => ipcRenderer.invoke("open", p),
  openUrl: u => ipcRenderer.invoke("open-url", u),
  platform: () => ipcRenderer.invoke("platform"),
  pathOf: file => webUtils.getPathForFile(file),
  on: (ch, fn) => { if (["progress", "net", "meeting"].includes(ch)) ipcRenderer.on(ch, (_e, m) => fn(m)); },
});
