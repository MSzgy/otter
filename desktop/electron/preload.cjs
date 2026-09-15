const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("otter", {
  call: (method, params = {}) =>
    ipcRenderer.invoke("otter:call", method, params),
  action: (name, value) => ipcRenderer.invoke("otter:action", name, value),
  subscribe: (callback) => {
    const listener = (_e, p) => callback(p);
    ipcRenderer.on("otter:event", listener);
    return () => ipcRenderer.removeListener("otter:event", listener);
  },
});
