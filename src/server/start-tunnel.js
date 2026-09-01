const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");

const PORT = process.env.PORT || 3000;
const CLOUDFLARED_PATH = path.join(__dirname, "..", "..", "cloudflared.exe");
const CLOUDFLARED_CMD = fs.existsSync(CLOUDFLARED_PATH) ? CLOUDFLARED_PATH : "cloudflared";

console.log(`Starting Cloudflare tunnel to http://localhost:${PORT} ...`);
console.log(`(using: ${CLOUDFLARED_CMD})\n`);

const tunnel = spawn(CLOUDFLARED_CMD, ["tunnel", "--url", `http://localhost:${PORT}`]);

let urlPrinted = false;

function scanForUrl(text) {
  const match = text.match(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/);
  if (match && !urlPrinted) {
    urlPrinted = true;
    console.log("\n=== Cloudflare tunnel active ===");
    console.log(`Public URL: ${match[0]}`);
    console.log(`Webhook endpoint to register in Razorpay dashboard: ${match[0]}/webhook`);
    console.log("Keep this terminal open while testing. Press Ctrl+C to stop the tunnel.\n");
  }
}

tunnel.stdout.on("data", (data) => scanForUrl(data.toString()));
tunnel.stderr.on("data", (data) => scanForUrl(data.toString()));

tunnel.on("error", (err) => {
  console.error("Failed to start cloudflared:", err.message);
  console.error("Make sure cloudflared.exe is in this folder, or installed and on your PATH.");
  console.error("Download: https://github.com/cloudflare/cloudflared/releases/latest");
  process.exit(1);
});

tunnel.on("close", (code) => {
  console.log(`cloudflared exited with code ${code}`);
});

process.on("SIGINT", () => {
  tunnel.kill();
  process.exit(0);
});
