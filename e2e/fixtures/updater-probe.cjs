// Loaded before main, so even a regression cannot contact GitHub. This entry
// intentionally bypasses electron-app.ts and its autoUpdate=false seed.
const Module = require("node:module");
const { EventEmitter } = require("node:events");
const { app } = require("electron");
Object.defineProperty(app, "isPackaged", { value: process.env.DISKHOUND_PROBE_PACKAGED === "1" });
globalThis.updaterProbe = { imports: 0, checks: 0 };
const updater = new EventEmitter();
updater.checkForUpdates = async () => { globalThis.updaterProbe.checks++; return null; };
updater.quitAndInstall = () => {
  const error = new Error("Stubbed installation failure");
  if (globalThis.updaterInstallFailure === "event") updater.emit("error", error);
  else throw error;
};
const load = Module._load;
Module._load = function (id, ...args) {
  if (id === "electron-updater") {
    globalThis.updaterProbe.imports++;
    return { autoUpdater: updater };
  }
  return load.call(this, id, ...args);
};
require("../../dist-electron/main.cjs");
