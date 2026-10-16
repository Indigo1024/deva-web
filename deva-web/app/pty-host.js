var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// src/main/pty-host.ts
var pty = __toESM(require("@lydell/node-pty"));
var import_node_fs = require("node:fs");
var import_node_os = require("node:os");
var sessions = /* @__PURE__ */ new Map();
var parentPort = process.parentPort;
function post(msg) {
  parentPort.postMessage(msg);
}
function defaultShell() {
  if (process.platform === "win32") return "powershell.exe";
  return process.env.SHELL || "/bin/bash";
}
function safeCwd(cwd) {
  if (cwd && (0, import_node_fs.existsSync)(cwd)) return cwd;
  return (0, import_node_os.homedir)();
}
function handleCreate(msg) {
  let proc;
  try {
    proc = pty.spawn(msg.shellPath || defaultShell(), msg.shellArgs ?? [], {
      name: "xterm-256color",
      cols: msg.cols || 80,
      rows: msg.rows || 24,
      cwd: safeCwd(msg.cwd),
      env: { ...process.env }
    });
  } catch (err) {
    post({ type: "exit", id: msg.id, exitCode: -1, error: err instanceof Error ? err.message : String(err) });
    return;
  }
  sessions.set(msg.id, proc);
  proc.onData((data) => post({ type: "data", id: msg.id, data }));
  proc.onExit(({ exitCode }) => {
    post({ type: "exit", id: msg.id, exitCode });
    sessions.delete(msg.id);
  });
}
parentPort.on("message", (e) => {
  const msg = e.data;
  switch (msg.type) {
    case "create":
      handleCreate(msg);
      break;
    case "input":
      sessions.get(msg.id)?.write(msg.data);
      break;
    case "resize":
      try {
        sessions.get(msg.id)?.resize(msg.cols, msg.rows);
      } catch {
      }
      break;
    case "dispose":
      try {
        sessions.get(msg.id)?.kill();
      } catch {
      }
      sessions.delete(msg.id);
      break;
  }
});
//# sourceMappingURL=pty-host.js.map
