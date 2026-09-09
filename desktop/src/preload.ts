import { contextBridge, ipcRenderer } from "electron";
// No generic IPC, filesystem, shell, or keychain access reaches the renderer.
contextBridge.exposeInMainWorld("connect", {
  state: () => ipcRenderer.invoke("connect:state"),
  save: (value: unknown) => ipcRenderer.invoke("connect:save", value),
  pair: () => ipcRenderer.invoke("connect:pair"),
  cancel: () => ipcRenderer.invoke("connect:cancel"),
  sync: () => ipcRenderer.invoke("connect:sync"),
  pause: () => ipcRenderer.invoke("connect:pause"),
  disconnect: () => ipcRenderer.invoke("connect:disconnect"),
  dashboard: () => ipcRenderer.invoke("connect:dashboard"),
  update: () => ipcRenderer.invoke("connect:update"),
});
