// Мост индикатора записи: только «команда» (из белого списка в главном процессе) и время.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("pkInd", {
  command: c => ipcRenderer.send("indicator-command", c),
  onTick: fn => ipcRenderer.on("indicator-tick", (_e, s) => fn(s)),
});
