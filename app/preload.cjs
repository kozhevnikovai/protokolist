// Мост между интерфейсом и главным процессом: только перечисленные методы, без доступа к Node.
const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("pk", {
  core: (method, args) => ipcRenderer.invoke("core", method, args),
  pickFile: () => ipcRenderer.invoke("pick-file"),
  pickDir: () => ipcRenderer.invoke("pick-dir"),
  saveRecording: (name, bytes) => ipcRenderer.invoke("save-recording", name, bytes),
  open: p => ipcRenderer.invoke("open", p),
  openUrl: u => ipcRenderer.invoke("open-url", u),
  platform: () => ipcRenderer.invoke("platform"),
  pathOf: file => webUtils.getPathForFile(file),
  on: (ch, fn) => { if (["progress", "net", "meeting"].includes(ch)) ipcRenderer.on(ch, (_e, m) => fn(m)); },
});
