import minimist from "minimist";
import { HueEvents } from "./lib/events.js";
import { Hue } from "./lib/hue.js";
import { Scheduler } from "./lib/scheduler.js";
import { Entertainment } from "./lib/entertainment.js";
import { decodeFrame } from "./lib/color.js";
import { listenArtNet } from "./lib/artnet.js";
import {
  storeConfig,
  migrateConfig,
  mapFixtures,
  validateConfig,
  saveConfig
} from "./lib/config.js";
import { setup } from "./lib/setup.js";
import { startDashboard } from "./lib/dashboard.js";

const help = `DMX Hue 4 — reliable local Art-Net → Hue v2
  dmx-hue setup [--ip ADDRESS] [--force] [--list]
  dmx-hue [--config FILE] [--host 0.0.0.0] [-u UNIVERSE] [-a ADDRESS]
          [-t MILLISECONDS|channel] [--mode standard|entertainment|mixed]
          [--source-ip IP] [--dashboard-host 127.0.0.1] [--dashboard-port 8080]
          [--group-interval-ms 1000]
          [--no-dashboard] [--refresh-ms 30000] [--stream-fps 25]
  dmx-hue status [--config FILE]

Luminair keeps control of colors/scenes. Universes use raw Art-Net numbering.
Use setup to migrate the old patch and optionally select Hue groups/Entertainment.
Default signal-loss behavior: hold the last received look. No live data, no writes.
`;
export class DmxHue {
  constructor(args) {
    this.args = minimist(args, {
      string: [
        "config",
        "ip",
        "host",
        "transition",
        "mode",
        "source-ip",
        "dashboard-host"
      ],
      boolean: ["help", "version", "list", "force", "white", "colorloop"],
      alias: {
        h: "host",
        a: "address",
        u: "universe",
        t: "transition",
        w: "white",
        l: "list",
        i: "ip"
      },
      default: { "dashboard-port": 8080 }
    });
    this.stopping = false;
    this.tickBusy = false;
    this.lastSnapshot = 0;
    this.lastStreamCheck = 0;
    this.nextStream = 0;
    this.lastError = null;
    this.artnet = null;
    this.latestFrame = null;
    this.startedAt = Date.now();
  }
  async run() {
    const a = this.args;
    if (a.help) {
      console.log(help);
      return;
    }
    if (a.version) {
      console.log("4.0.0-beta.1");
      return;
    }
    this.store = storeConfig(a.config);
    if (a._[0] === "setup") return setup(this.store, a);
    this.config = migrateConfig(this.store.store);
    const c = this.config;
    if (a.universe !== undefined) c.universe = Number(a.universe);
    if (a.address !== undefined) c.address = Number(a.address);
    if (a.transition !== undefined)
      c.transition =
        a.transition === "channel" ? "channel" : Number(a.transition);
    if (a.mode !== undefined) c.mode = a.mode;
    if (a.white) c.white = true;
    if (a["refresh-ms"] !== undefined) c.refreshMs = Number(a["refresh-ms"]);
    if (a["group-interval-ms"] !== undefined)
      c.groupIntervalMs = Number(a["group-interval-ms"]);
    if (a["stream-fps"] !== undefined) c.streamFps = Number(a["stream-fps"]);
    if (a.colorloop || c.legacy?.colorloop)
      throw new Error(
        "Legacy RGB=1 colorloop is unsupported. Disable it during setup and use Luminair effects."
      );
    if (!c.bridge?.key)
      throw new Error("Bridge not paired. Run dmx-hue setup.");
    validateConfig(c);
    this.hue = new Hue(c.bridge, {
      save: (bridge) => {
        // Persist recovery addresses without persisting temporary command-line overrides.
        const saved = migrateConfig(this.store.store);
        saved.bridge = { ...bridge };
        saveConfig(this.store, saved);
      }
    });
    this.scheduler = new Scheduler({
      write: (path, body) => this.hue.write(path, body),
      lights: () => this.hue.lights(),
      connectivity: () => this.hue.connectivity(),
      groups: () => this.hue.groups(c.groups),
      refreshMs: c.refreshMs,
      groupIntervalMs: c.groupIntervalMs ?? 1000,
      onError: (e) => this.logError(e)
    });
    this.hue.on("connected", () => {
      if (mapFixtures(c, this.hue.lights())) {
        validateConfig(c);
        const saved = migrateConfig(this.store.store);
        saved.fixtures = c.fixtures;
        saveConfig(this.store, saved);
      }
      this.events?.stop();
      if (this.stream?.state === "active")
        this.stream.fail(
          new Error("Bridge reconnected; renewing Entertainment transport.")
        );
      this.scheduler.reapply();
      this.lastSnapshot = Date.now();
      if (this.latestFrame) this.accept(this.latestFrame);
    });
    await this.hue.ensureConnected();
    validateConfig(c);
    if (a._[0] === "status") {
      console.log(JSON.stringify(this.status(), null, 2));
      return;
    }
    this.events = new HueEvents(this.hue, () => {
      this.scheduler.updateConnectivity();
      this.scheduler.reconcile(this.hue.lights());
    });
    if (c.mode !== "standard") {
      this.stream = new Entertainment({
        hue: this.hue,
        areaId: c.entertainmentArea,
        fixtureIds: c.fixtures.map((f) => f.id),
        fps: c.streamFps,
        onError: (e) => this.logError(e)
      });
    }
    this.artnet = await listenArtNet({
      host: a.host || "0.0.0.0",
      universe: c.universe,
      sourceIp: a["source-ip"],
      onFrame: (frame) => this.accept(frame),
      onError: (e) => this.logError(e)
    });
    if (a.dashboard !== false)
      this.dashboard = await startDashboard({
        host: a["dashboard-host"] || "127.0.0.1",
        port: Number(a["dashboard-port"]),
        status: () => this.status(),
        reapply: () => this.scheduler.reapply()
      });
    this.timer = setInterval(
      () => this.tick().catch((e) => this.logError(e)),
      25
    );
    for (const signal of ["SIGINT", "SIGTERM"])
      process.once(signal, () => this.stop().then(() => process.exit(0)));
    console.log(
      `Listening for Art-Net universe ${c.universe}, address ${c.address}; mode ${c.mode}.`
    );
    console.log(`Configuration: ${this.store.path}`);
    if (this.dashboard)
      console.log(
        `Status page: http://${a["dashboard-host"] || "127.0.0.1"}:${a["dashboard-port"]}`
      );
  }
  accept(frame) {
    this.latestFrame = frame;
    for (const [id, target] of decodeFrame(frame.dmx, this.config))
      this.scheduler.set(id, target);
    this.stream?.setTargets(this.scheduler.entries);
  }
  async tick() {
    if (this.stopping || this.tickBusy) return;
    this.tickBusy = true;
    try {
      if (!(await this.hue.ensureConnected())) {
        this.events?.stop();
        return;
      }
      if (this.stopping) return;
      this.events?.start();
      const now = Date.now();
      if (now - this.lastSnapshot >= 10000) {
        this.lastSnapshot = now;
        if (!(await this.hue.snapshot())) return;
        this.scheduler.reconcile(this.hue.lights());
      }
      if (this.stream) {
        this.stream.fixtureIds = this.config.fixtures.map((f) => f.id);
        this.stream.setTargets(this.scheduler.entries);
        // Also exclude area lights owned by another application.
        const area = this.hue.resources.get(this.config.entertainmentArea);
        if (area)
          try {
            this.stream.configure(area);
          } catch (e) {
            this.stream.error = e.message;
          }
        if (
          this.stream.state === "active" &&
          now - this.lastStreamCheck >= 5000
        ) {
          this.lastStreamCheck = now;
          try {
            await this.stream.health();
          } catch (e) {
            this.stream.fail(e);
          }
        }
        if (this.stream.state !== "active" && this.stream.owned) {
          // Never start REST fallback until our stream has been released successfully.
          try {
            await this.stream.stop();
            this.scheduler.reapply();
          } catch (e) {
            this.scheduler.excluded = new Set(this.stream.lightIds);
            this.logError(e);
            return;
          }
        }
        if (
          this.stream.state !== "active" &&
          now >= this.nextStream &&
          this.stream.ready()
        ) {
          this.nextStream = now + 15000;
          try {
            if (
              this.config.mode === "entertainment" &&
              this.config.fixtures.some((f) => !this.stream.lightIds.has(f.id))
            )
              throw new Error(
                "Entertainment-only mode does not cover all DMX fixtures. Select Mixed mode."
              );
            // Drain older REST write before entering streaming control.
            if (!this.scheduler.busy) await this.stream.start();
          } catch (e) {
            this.stream.error = e.message;
            this.logError(e);
          }
        }
        // Refresh resource ownership after start/stop to avoid acting on stale status.
        this.scheduler.excluded =
          this.stream.state === "active" ||
          this.stream.owned ||
          area?.status === "active"
            ? new Set(this.stream.lightIds)
            : new Set();
      }
      // Respect lights streamed by other applications, even in Standard mode.
      const excluded = new Set(this.stream ? this.scheduler.excluded : []);
      for (const [id, light] of this.hue.lights())
        if (light.mode === "streaming") excluded.add(id);
      this.scheduler.excluded = excluded;
      await this.scheduler.tick();
    } finally {
      this.tickBusy = false;
    }
  }
  logError(error) {
    if (this.lastError !== error.message)
      console.error(new Date().toISOString(), error.message);
    this.lastError = error.message;
  }
  status() {
    const lights = this.hue?.lights() || new Map();
    const connectivity = [...(this.hue?.resources?.values() || [])].filter(
      (r) => r.type === "zigbee_connectivity"
    );
    return {
      version: "4.0.0-beta.1",
      uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
      mode: this.config?.mode,
      bridge: {
        connected: this.hue?.connected || false,
        ip: this.hue?.config.ip,
        model: this.hue?.config.model,
        error: this.hue?.lastError
      },
      artnet: this.artnet?.stats || { packets: 0, lastFrameAt: 0 },
      universe: this.config?.universe,
      fixtures: this.config?.fixtures.map((f, i) => ({
        name: f.name,
        address:
          this.config.address +
          i * (this.config.white ? 5 : 3) +
          (this.config.transition === "channel" ? 1 : 0),
        present: lights.has(f.id),
        connectivity:
          connectivity.find(
            (r) => r.owner?.rid === lights.get(f.id)?.owner?.rid
          )?.status || "unknown"
      })),
      updates: this.scheduler?.status(),
      eventsConnected: this.events?.connected || false,
      entertainment: this.stream?.status() || { state: "disabled" },
      lastError: this.lastError
    };
  }
  async stop() {
    this.stopping = true;
    clearInterval(this.timer);
    this.events?.stop();
    const deadline = Date.now() + 12000;
    while (this.tickBusy && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 25));
    if (this.stream)
      try {
        await this.stream.stop();
      } catch (e) {
        this.logError(e);
      }
    if (this.artnet) await this.artnet.close();
    if (this.dashboard) await new Promise((r) => this.dashboard.close(r));
  }
}
