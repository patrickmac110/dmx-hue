import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { dtls } = require("node-dtls-client");

export function encodeStream(areaId, channels, sequence = 0) {
  if (!/^[a-f0-9-]{36}$/i.test(areaId))
    throw new Error("Invalid Entertainment area ID");
  if (channels.length > 20)
    throw new Error("At most 20 channels per streaming packet");
  const packet = Buffer.alloc(52 + 7 * channels.length);
  packet.write("HueStream", 0, "ascii");
  packet[9] = 2;
  packet[11] = sequence & 255;
  packet.write(areaId.toLowerCase(), 16, 36, "ascii");
  channels.forEach(({ id, rgb }, index) => {
    if (
      !Number.isInteger(id) ||
      id < 0 ||
      id > 255 ||
      rgb.length !== 3 ||
      rgb.some((v) => !Number.isFinite(v))
    )
      throw new Error("Invalid streaming channel");
    const offset = 52 + 7 * index;
    packet[offset] = id;
    rgb.forEach((v, i) =>
      packet.writeUInt16BE(
        Math.round(Math.max(0, Math.min(255, v)) * 257),
        offset + 1 + i * 2
      )
    );
  });
  return packet;
}
export function areaChannels(area, resources, fixtureIds) {
  const configured = new Set(fixtureIds);
  const channels = [];
  for (const channel of area.channels || []) {
    const lights = new Set();
    for (const member of channel.members || []) {
      const service = resources.get(member.service.rid);
      if (service?.type === "light") lights.add(service.id);
      else {
        if (service?.type !== "entertainment" || service.renderer === false)
          throw new Error(
            "Area contains a non-rendering or unknown Entertainment service"
          );
        const device = resources.get(service.owner?.rid);
        for (const s of device?.services || [])
          if (s.rtype === "light") lights.add(s.rid);
      }
    }
    if (!lights.size || [...lights].some((id) => !configured.has(id)))
      throw new Error(
        "Every light in the Entertainment area must have a DMX fixture slot."
      );
    channels.push({ id: channel.channel_id, lights: [...lights] });
  }
  if (!channels.length) throw new Error("Entertainment area has no channels");
  if (new Set(channels.map((c) => c.id)).size !== channels.length)
    throw new Error("Duplicate Entertainment channel IDs");
  return channels;
}
export class Entertainment {
  constructor({
    hue,
    areaId,
    fixtureIds,
    fps = 25,
    onError = () => {},
    createSocket = dtls.createSocket
  }) {
    Object.assign(this, {
      hue,
      areaId,
      fixtureIds,
      fps,
      onError,
      createSocket
    });
    this.channels = [];
    this.lightIds = new Set();
    this.state = "idle";
    this.error = null;
    this.socket = null;
    this.timer = null;
    this.sequence = 0;
    this.frames = 0;
    this.targets = new Map();
    this.owned = false;
    this.owner = null;
    this.sending = false;
  }
  configure(area) {
    this.channels = areaChannels(area, this.hue.resources, this.fixtureIds);
    this.lightIds = new Set(this.channels.flatMap((c) => c.lights));
  }
  setTargets(entries) {
    const now = Date.now();
    for (const [id, e] of entries) {
      const previous = this.targets.get(id);
      if (previous?.key === e.key) continue;
      const to = e.target.on ? e.target.rgb : [0, 0, 0];
      this.targets.set(id, {
        key: e.key,
        to,
        from: previous ? this.sample(previous, now) : to,
        start: now,
        duration: e.target.duration
      });
    }
  }
  sample(t, now = Date.now()) {
    const fraction =
      t.duration > 0 ? Math.min(1, (now - t.start) / t.duration) : 1;
    return t.from.map((v, i) => v + (t.to[i] - v) * fraction);
  }
  ready() {
    return [...this.lightIds].every((id) => this.targets.has(id));
  }
  async start() {
    if (this.state === "active") return;
    const [area] = await this.hue.api(
      `entertainment_configuration/${this.areaId}`
    );
    if (!area) throw new Error("Selected Entertainment area no longer exists");
    this.configure(area);
    if (!this.ready()) return; // Do not black out a partially patched/short DMX frame.
    if (area.status === "active")
      throw new Error(
        "Entertainment area is already active. Stop the other stream before starting this one."
      );
    await this.hue.write(`entertainment_configuration/${this.areaId}`, {
      action: "start"
    });
    this.owned = true;
    try {
      const [active] = await this.hue.api(
        `entertainment_configuration/${this.areaId}`
      );
      this.owner = active?.active_streamer?.rid || null;
      await new Promise((resolve, reject) => {
        const socket = this.createSocket({
          type: "udp4",
          address: this.hue.config.ip,
          port: 2100,
          psk: {
            [this.hue.config.key]: Buffer.from(this.hue.config.clientKey, "hex")
          },
          ciphers: ["TLS_PSK_WITH_AES_128_GCM_SHA256"],
          timeout: 5000
        });
        this.socket = socket;
        const timer = setTimeout(
          () => reject(new Error("Entertainment handshake timed out")),
          6000
        );
        socket.once("connected", () => {
          clearTimeout(timer);
          resolve();
        });
        socket.on("error", (error) => {
          clearTimeout(timer);
          reject(error);
          if (this.socket === socket) this.fail(error);
        });
        socket.on("close", () => {
          clearTimeout(timer);
          reject(new Error("Entertainment socket closed"));
          if (this.socket === socket && this.state === "active")
            this.fail(new Error("Entertainment connection closed"));
        });
      });
      this.state = "active";
      this.error = null;
      this.timer = setInterval(() => this.send(), Math.round(1000 / this.fps));
      this.send();
    } catch (error) {
      this.fail(error);
      await this.stop();
      throw error;
    }
  }
  send() {
    if (this.state !== "active" || this.sending || !this.ready()) return;
    const now = Date.now();
    const socket = this.socket;
    try {
      const updates = this.channels.map((channel) => {
        const values = channel.lights.map((id) =>
          this.sample(this.targets.get(id), now)
        );
        if (
          values.some((rgb) =>
            rgb.some((v, i) => Math.abs(v - values[0][i]) > 0.01)
          )
        )
          throw new Error(
            "One Entertainment channel contains lights with different DMX targets; select an area with independent channels."
          );
        return { id: channel.id, rgb: values[0] };
      });
      this.sending = true;
      let outstanding = Math.ceil(updates.length / 20);
      for (let i = 0; i < updates.length; i += 20) {
        socket.send(
          encodeStream(this.areaId, updates.slice(i, i + 20), this.sequence++),
          (error) => {
            if (this.socket !== socket) return;
            if (error) this.fail(error);
            if (--outstanding === 0) this.sending = false;
          }
        );
      }
      this.frames++;
    } catch (error) {
      this.sending = false;
      this.fail(error);
    }
  }
  fail(error) {
    clearInterval(this.timer);
    this.timer = null;
    this.state = "failed";
    this.error = error.message;
    this.onError(error);
  }
  async health() {
    if (!this.owned) return;
    const [area] = await this.hue.api(
      `entertainment_configuration/${this.areaId}`
    );
    if (
      area?.status !== "active" ||
      (this.owner && area.active_streamer?.rid !== this.owner)
    ) {
      this.owned = false;
      this.fail(new Error("Entertainment control was released or taken over."));
    }
  }
  async stop() {
    clearInterval(this.timer);
    this.timer = null;
    this.state = "stopping";
    const socket = this.socket;
    this.socket = null;
    if (socket)
      try {
        socket.close();
      } catch {}
    if (this.owned) {
      const [area] = await this.hue.api(
        `entertainment_configuration/${this.areaId}`
      );
      if (
        area?.status === "active" &&
        (!this.owner || area.active_streamer?.rid === this.owner)
      )
        await this.hue.write(`entertainment_configuration/${this.areaId}`, {
          action: "stop"
        });
      this.owned = false;
    }
    this.state = "idle";
    this.sending = false;
  }
  status() {
    return {
      state: this.state,
      error: this.error,
      frames: this.frames,
      lights: this.lightIds.size,
      channels: this.channels.length,
      fps: this.fps
    };
  }
}
