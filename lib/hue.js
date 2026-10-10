import https from "node:https";
import { EventEmitter } from "node:events";
import { Bonjour } from "bonjour-service";

const normalizeId = (value) =>
  String(value || "")
    .replace(/[^a-f0-9]/gi, "")
    .toUpperCase();
export class HueError extends Error {
  constructor(message, { status = 0, errors = [] } = {}) {
    super(message);
    this.status = status;
    this.errors = errors;
  }
}
// Hue bridges use a certificate whose CN identifies the bridge. Pin its fingerprint
// during physical-button pairing, then require that certificate on subsequent sockets.
export function requestHue(
  { ip, key, bridgeId, pin, port = 443 },
  path,
  { method = "GET", body, timeout = 5000 } = {}
) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = https.request(
      {
        hostname: ip,
        port,
        path,
        method,
        rejectUnauthorized: false,
        agent: false,
        headers: {
          ...(key ? { "hue-application-key": key } : {}),
          ...(data
            ? {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(data)
              }
            : {})
        }
      },
      (res) => {
        const cert = res.socket.getPeerCertificate();
        const fingerprint = cert.fingerprint256;
        if (
          !fingerprint ||
          (pin && fingerprint !== pin) ||
          (bridgeId && normalizeId(cert.subject?.CN) !== normalizeId(bridgeId))
        ) {
          res.destroy();
          reject(
            new HueError(
              "Bridge certificate identity changed; run setup to verify and re-pair."
            )
          );
          return;
        }
        let text = "";
        res.on("data", (chunk) => {
          text += chunk;
          if (text.length > 4 * 1024 * 1024)
            req.destroy(new Error("Hue response too large"));
        });
        res.on("error", reject);
        res.on("end", () => {
          try {
            const payload = text ? JSON.parse(text) : {};
            const errors =
              payload.errors ||
              (Array.isArray(payload)
                ? payload.filter((x) => x.error).map((x) => x.error)
                : []);
            if (res.statusCode >= 400 || errors.length)
              return reject(
                new HueError(
                  errors.map((e) => e.description || "Hue error").join("; ") ||
                    `Hue HTTP ${res.statusCode}`,
                  { status: res.statusCode, errors }
                )
              );
            resolve({ payload, fingerprint });
          } catch (error) {
            reject(error);
          }
        });
      }
    );
    // Absolute deadline, not only an inactivity timeout.
    const timer = setTimeout(
      () => req.destroy(new Error("Hue request timed out")),
      timeout
    );
    req.on("close", () => clearTimeout(timer));
    req.on("error", reject);
    req.on("socket", (socket) =>
      socket.once("secureConnect", () => {
        const cert = socket.getPeerCertificate();
        if (
          !cert.fingerprint256 ||
          (pin && cert.fingerprint256 !== pin) ||
          (bridgeId && normalizeId(cert.subject?.CN) !== normalizeId(bridgeId))
        ) {
          req.destroy(
            new HueError(
              "Bridge certificate identity changed; verify the bridge in setup."
            )
          );
          return;
        }
        if (data) req.write(data);
        req.end();
      })
    );
  });
}
export async function discoverBridges(timeout = 3500) {
  const bonjour = new Bonjour();
  const found = new Map();
  const browser = bonjour.find({ type: "hue" }, (service) => {
    const id = normalizeId(service.txt?.bridgeid);
    const ip = service.addresses?.find((a) => /^\d+\.\d+\.\d+\.\d+$/.test(a));
    if (id && ip) found.set(id, { id, ip, name: service.name });
  });
  await new Promise((resolve) => setTimeout(resolve, timeout));
  browser.stop();
  bonjour.destroy();
  return [...found.values()];
}
export async function inspectBridge(ip) {
  const { payload, fingerprint } = await requestHue({ ip }, "/api/config");
  if (!payload.bridgeid)
    throw new Error("Address did not identify a Hue bridge");
  return {
    id: normalizeId(payload.bridgeid),
    ip,
    model: payload.modelid,
    firmware: payload.swversion,
    fingerprint
  };
}
export async function pairBridge(ip) {
  const bridge = await inspectBridge(ip);
  const { payload } = await requestHue(
    { ip, bridgeId: bridge.id, pin: bridge.fingerprint },
    "/api",
    {
      method: "POST",
      body: { devicetype: "dmx-hue#raspberrypi", generateclientkey: true }
    }
  );
  const credentials = payload[0]?.success;
  if (!credentials?.username)
    throw new Error(
      "Pairing failed; press the Hue bridge button and try again."
    );
  return {
    ip,
    id: bridge.id,
    pin: bridge.fingerprint,
    key: credentials.username,
    clientKey: credentials.clientkey
  };
}
export class Hue extends EventEmitter {
  constructor(
    config,
    { save = () => {}, discover = discoverBridges, request = requestHue } = {}
  ) {
    super();
    this.config = config;
    this.save = save;
    this.discover = discover;
    this.request = request;
    this.resources = new Map();
    this.connected = false;
    this.lastError = null;
    this.connecting = null;
    this.nextConnect = 0;
  }
  credentials() {
    return {
      ip: this.config.ip,
      key: this.config.key,
      bridgeId: this.config.id,
      pin: this.config.pin
    };
  }
  async api(path, options) {
    const { payload } = await this.request(
      this.credentials(),
      path ? `/clip/v2/resource/${path}` : "/clip/v2/resource",
      options
    );
    return payload.data || [];
  }
  async ensureConnected() {
    if (this.connected) return true;
    if (this.connecting) return this.connecting;
    if (Date.now() < this.nextConnect) return false;
    this.connecting = this.reconnect().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }
  async reconnect() {
    this.nextConnect = Date.now() + 5000;
    const candidates = [];
    if (this.config.ip)
      candidates.push({ ip: this.config.ip, id: this.config.id });
    let error;
    const tryCandidate = async (candidate) => {
      try {
        const creds = { ...this.credentials(), ip: candidate.ip };
        // Existing installations can migrate their key without pressing the button.
        const info = await this.request(creds, "/api/config");
        const id = normalizeId(info.payload.bridgeid);
        if (!id || (this.config.id && id !== normalizeId(this.config.id)))
          throw new Error("Discovered a different bridge");
        const verified = {
          ...creds,
          bridgeId: id,
          pin: this.config.pin || info.fingerprint
        };
        const { payload } = await this.request(verified, "/clip/v2/resource");
        this.config.ip = candidate.ip;
        this.config.id = id;
        this.config.pin = verified.pin;
        this.config.model = info.payload.modelid;
        this.save(this.config);
        this.resources = new Map((payload.data || []).map((r) => [r.id, r]));
        this.connected = true;
        this.lastError = null;
        this.emit("connected");
        return true;
      } catch (e) {
        error = e;
        return false;
      }
    };
    for (const c of candidates) if (await tryCandidate(c)) return true;
    if (this.config.id) {
      try {
        for (const candidate of await this.discover()) {
          if (
            normalizeId(candidate.id) === normalizeId(this.config.id) &&
            (await tryCandidate(candidate))
          )
            return true;
        }
      } catch (e) {
        error = e;
      }
    }
    this.lastError = error?.message || "Bridge not found";
    this.emit("offline", this.lastError);
    return false;
  }
  disconnect(error) {
    this.connected = false;
    this.lastError = error.message;
    this.nextConnect = Date.now() + 3000;
  }
  async snapshot() {
    try {
      const data = await this.api("");
      this.resources = new Map(data.map((r) => [r.id, r]));
      return true;
    } catch (error) {
      this.disconnect(error);
      return false;
    }
  }
  lights() {
    return new Map([...this.resources].filter(([, r]) => r.type === "light"));
  }
  connectivity() {
    const devices = new Map(
      [...this.resources.values()]
        .filter((r) => r.type === "zigbee_connectivity")
        .map((r) => [r.owner?.rid, r.status])
    );
    return new Map(
      [...this.lights()].map(([id, light]) => [
        id,
        devices.get(light.owner?.rid) || "unknown"
      ])
    );
  }
  entertainment() {
    return [...this.resources.values()].filter(
      (r) => r.type === "entertainment_configuration"
    );
  }
  groups(ids = []) {
    return [...this.resources.values()]
      .filter((r) => ["room", "zone"].includes(r.type) && ids.includes(r.id))
      .map((group) => {
        const members = new Set();
        for (const child of group.children || []) {
          const resource = this.resources.get(child.rid);
          if (resource?.type === "light") members.add(resource.id);
          for (const service of resource?.services || [])
            if (service.rtype === "light") members.add(service.rid);
        }
        return {
          id: group.services?.find((s) => s.rtype === "grouped_light")?.rid,
          name: group.metadata?.name,
          members: [...members]
        };
      })
      .filter((g) => g.id && g.members.length);
  }
  async write(path, body) {
    if (!this.connected) throw new Error("Bridge offline");
    try {
      return await this.api(path, { method: "PUT", body });
    } catch (error) {
      if (
        !error.status ||
        error.status >= 500 ||
        error.status === 401 ||
        error.status === 403
      )
        this.disconnect(error);
      throw error;
    }
  }
}
