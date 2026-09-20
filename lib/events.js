import https from "node:https";

export function mergeResource(previous, patch) {
  const result = { ...previous };
  for (const [key, value] of Object.entries(patch)) {
    result[key] =
      value && typeof value === "object" && !Array.isArray(value)
        ? mergeResource(previous?.[key] || {}, value)
        : value;
  }
  return result;
}
// Server-sent events complement periodic snapshots; neither is a physical-light acknowledgement.
export class HueEvents {
  constructor(hue, onChange = () => {}) {
    this.hue = hue;
    this.onChange = onChange;
    this.request = null;
    this.nextAttempt = 0;
    this.connected = false;
  }
  start() {
    if (this.request || Date.now() < this.nextAttempt || !this.hue.connected)
      return;
    this.nextAttempt = Date.now() + 5000;
    const c = this.hue.config;
    const req = https.request(
      {
        hostname: c.ip,
        port: 443,
        path: "/eventstream/clip/v2",
        method: "GET",
        agent: false,
        rejectUnauthorized: false,
        headers: { Accept: "text/event-stream", "hue-application-key": c.key }
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          req.destroy();
          return;
        }
        this.connected = true;
        let buffer = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          buffer += chunk;
          if (buffer.length > 1024 * 1024) {
            req.destroy();
            return;
          }
          buffer = buffer.replace(/\r\n/g, "\n");
          let split;
          while ((split = buffer.indexOf("\n\n")) >= 0) {
            const frame = buffer.slice(0, split);
            buffer = buffer.slice(split + 2);
            const data = frame
              .split("\n")
              .filter((l) => l.startsWith("data:"))
              .map((l) => l.slice(5).trimStart())
              .join("\n");
            if (!data) continue;
            try {
              for (const event of JSON.parse(data))
                for (const patch of event.data || []) {
                  if (event.type === "delete")
                    this.hue.resources.delete(patch.id);
                  else
                    this.hue.resources.set(
                      patch.id,
                      mergeResource(this.hue.resources.get(patch.id), patch)
                    );
                }
              this.onChange();
            } catch {
              /* Ignore malformed events; the next full snapshot repairs state. */
            }
          }
        });
        res.on("error", () => {});
      }
    );
    this.request = req;
    req.on("socket", (socket) =>
      socket.once("secureConnect", () => {
        const cert = socket.getPeerCertificate();
        if (
          cert.fingerprint256 !== c.pin ||
          String(cert.subject?.CN).toUpperCase() !== c.id.toUpperCase()
        ) {
          req.destroy();
          return;
        }
        req.end();
      })
    );
    req.setTimeout(90000, () => req.destroy());
    req.on("error", () => {});
    req.on("close", () => {
      if (this.request === req) {
        this.request = null;
        this.connected = false;
      }
    });
  }
  stop() {
    const req = this.request;
    this.request = null;
    this.connected = false;
    req?.destroy();
  }
}
