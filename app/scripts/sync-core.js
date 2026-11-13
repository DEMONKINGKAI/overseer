// Copy the shared reducer into the UI so the webview runs exactly the code the tests cover.
const fs = require("fs");
const path = require("path");
const src = path.join(__dirname, "..", "..", "core");
const dst = path.join(__dirname, "..", "ui", "core");
fs.mkdirSync(dst, { recursive: true });
for (const f of ["state.js", "transcript.js"]) fs.copyFileSync(path.join(src, f), path.join(dst, f));
console.log("synced core → ui/core");
