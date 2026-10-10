import http from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
const html = (token) =>
  `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Church lighting status</title><style>body{font:18px system-ui;background:#111923;color:#eef4fa;max-width:850px;margin:40px auto;padding:20px}h1{font-size:30px}button{padding:14px 22px;border:0;border-radius:8px;background:#8ee0c5;color:#10261f;font-size:18px}pre{white-space:pre-wrap;background:#1c2b3b;padding:20px;border-radius:10px}p{line-height:1.5}</style><h1>Church lighting status</h1><p id="summary">Connecting…</p><button id="reapply">Reapply current look</button><p id="message"></p><pre id="detail"></pre><script>const token=${JSON.stringify(token)};async function refresh(){try{const r=await fetch('/status');const s=await r.json();document.querySelector('#summary').textContent=(s.bridge.connected?'Bridge connected':'Bridge offline — reconnecting')+' · '+(s.artnet.lastFrameAt?('Last Luminair frame '+Math.floor((Date.now()-s.artnet.lastFrameAt)/1000)+'s ago'):'Waiting for Luminair');document.querySelector('#detail').textContent=JSON.stringify(s,null,2)}catch{document.querySelector('#summary').textContent='Lighting service unavailable'}}document.querySelector('#reapply').onclick=async()=>{try{const r=await fetch('/reapply',{method:'POST',headers:{'X-Dmx-Hue-Token':token}});document.querySelector('#message').textContent=r.ok?'Current look queued again.':'Could not reapply.'}catch{document.querySelector('#message').textContent='Lighting service unavailable'}};refresh();setInterval(refresh,2000)</script></html>`;
export async function startDashboard({
  host = "127.0.0.1",
  port = 8080,
  status,
  reapply
}) {
  const token = randomBytes(24).toString("hex");
  const server = http.createServer((req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    // Reject cross-site requests and DNS rebinding via arbitrary Host headers.
    const hostname = (req.headers.host || "").split(":")[0];
    if (
      !/^(localhost|[a-z0-9-]+\.local|\d{1,3}(\.\d{1,3}){3})$/i.test(hostname)
    ) {
      res.writeHead(403).end();
      return;
    }
    if (
      req.headers.origin &&
      req.headers.origin !== `http://${req.headers.host}`
    ) {
      res.writeHead(403).end();
      return;
    }
    if (req.method === "GET" && req.url === "/") {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(html(token));
    } else if (req.method === "GET" && req.url === "/status") {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(status()));
    } else if (req.method === "POST" && req.url === "/reapply") {
      const provided = Buffer.from(
        String(req.headers["x-dmx-hue-token"] || "")
      );
      if (
        provided.length !== token.length ||
        !timingSafeEqual(provided, Buffer.from(token))
      ) {
        res.writeHead(403).end();
        return;
      }
      reapply();
      res.writeHead(204).end();
    } else res.writeHead(404).end();
  });
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  return server;
}
