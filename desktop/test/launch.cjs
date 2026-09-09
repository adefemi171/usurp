// Test harness only: isolate application state and substitute synthetic reader
// data without changing HOME or touching the user's actual coding transcripts.
const electron = require("electron");
process.on("uncaughtException", error => { console.error("Test launcher:", error.message); electron.app.exit(1); });
electron.app.on("browser-window-created", (_event, window) => { window.hide(); window.on("show", () => window.hide()); });
electron.app.whenReady().then(() => electron.app.dock?.hide());
const os = require("node:os");
const path = require("node:path");
if (!process.env.CONNECT_TEST_DATA_DIR || !process.env.CONNECT_TEST_FIXTURES) throw new Error("Missing test paths");
electron.app.setPath("userData", process.env.CONNECT_TEST_DATA_DIR);
global.__connectOpenedLinks = [];
electron.shell.openExternal = async url => { global.__connectOpenedLinks.push(url); };
const fork = electron.utilityProcess.fork.bind(electron.utilityProcess);
electron.utilityProcess.fork = (_file, args, options) => fork(path.join(__dirname, "worker.cjs"), args, options);
require("../dist/main.cjs");
