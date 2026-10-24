// USB serial for the physical otter. `serialport` is an optional dependency and is
// loaded only when the bridge first needs it, so a missing package or a native
// binding that fails to load leaves the desktop app untouched.
let loaded;
function load() {
  if (loaded === undefined) {
    try {
      loaded = require("serialport");
    } catch {
      loaded = null;
    }
  }
  return loaded;
}

module.exports = {
  available: () => !!load(),
  list: () => load().SerialPort.list(),
  // Opens a line-based connection. hupcl:false keeps DTR/RTS up on close: dropping
  // them can reset this ESP32-S3 into its download mode.
  open(path, { onLine, onClose }) {
    const { SerialPort } = load();
    return new Promise((resolve, reject) => {
      const port = new SerialPort({
        path,
        baudRate: 115200,
        hupcl: false,
        autoOpen: false,
      });
      let buffer = "";
      // Callbacks run inside serialport's event handlers, where a throw would be an
      // uncaught exception in Electron's main process, so they are fenced off here.
      const safely =
        (fn) =>
        (...args) => {
          try {
            fn(...args);
          } catch {}
        };
      port.on(
        "data",
        safely((chunk) => {
          buffer += chunk.toString("utf8");
          if (buffer.length > 4096) buffer = buffer.slice(-1024); // a chatty device cannot grow this
          let end;
          while ((end = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, end).trim();
            buffer = buffer.slice(end + 1);
            if (line) onLine(line);
          }
        }),
      );
      port.on("close", safely(onClose));
      port.on("error", () => {}); // a close follows; errors must not crash the app
      port.open((error) => {
        if (error) return reject(error);
        resolve({
          write: (line) => port.write(line + "\n"),
          close: () => {
            if (port.isOpen) port.close(() => {});
          },
        });
      });
    });
  },
};
