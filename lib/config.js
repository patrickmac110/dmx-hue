import fs from "node:fs";
import Conf from "conf";

export function storeConfig(file) {
  if (file) {
    const path = file;
    return {
      path,
      get store() {
        return JSON.parse(fs.readFileSync(path, "utf8"));
      },
      set store(value) {
        const tmp = path + ".tmp";
        fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", {
          mode: 0o600
        });
        fs.renameSync(tmp, path);
      }
    };
  }
  return new Conf({ projectName: "dmx-hue" });
}
export function migrateConfig(old = {}) {
  if (old.schema === 4) return structuredClone(old);
  return {
    schema: 4,
    bridge: { ip: old.bridge, key: old.user },
    address: old.dmxAddress ?? 1,
    universe: old.universe ?? 0,
    transition: old.transition ?? 100,
    white: old.white ?? false,
    mode: "standard",
    groups: [],
    fixtures: [],
    legacy: {
      order: old.lightsOrder || [],
      disabled: old.disabledLights || {},
      colorloop: old.colorloop || false
    },
    refreshMs: 30000,
    streamFps: 25,
    holdLast: true
  };
}
export function mapFixtures(config, lights) {
  // Once materialized, never compact or reorder slots, including missing lights.
  if (config.fixtures?.length) return false;
  const all = [...lights.values()].filter(
    (l) => !config.legacy?.disabled?.[l.id_v1?.split("/").pop()]
  );
  const order = (config.legacy?.order || []).map(String);
  all.sort((a, b) => {
    const ai = order.indexOf(a.id_v1?.split("/").pop()),
      bi = order.indexOf(b.id_v1?.split("/").pop());
    if (ai >= 0 || bi >= 0)
      return (ai < 0 ? Infinity : ai) - (bi < 0 ? Infinity : bi);
    return (
      Number(a.id_v1?.split("/").pop() || 0) -
      Number(b.id_v1?.split("/").pop() || 0)
    );
  });
  config.fixtures = all.map((l) => ({
    id: l.id,
    name: l.metadata?.name || l.id,
    legacyId: l.id_v1?.split("/").pop()
  }));
  return true;
}
export function validateConfig(c) {
  const integer = (n, min, max) => Number.isInteger(n) && n >= min && n <= max;
  if (!integer(c.universe, 0, 32767))
    throw new Error("Art-Net universe must be 0–32767 (raw wire numbering).");
  if (!integer(c.address, 1, 512))
    throw new Error("DMX start address must be 1–512.");
  if (c.transition !== "channel" && !integer(c.transition, 0, 65534000))
    throw new Error("Invalid transition duration.");
  if (!["standard", "entertainment", "mixed"].includes(c.mode))
    throw new Error("Invalid output mode.");
  if (!integer(c.streamFps ?? 25, 1, 50))
    throw new Error("Streaming rate must be 1–50 frames/sec.");
  if (!integer(c.refreshMs ?? 30000, 0, 3600000))
    throw new Error("Invalid refresh interval.");
  if (!Array.isArray(c.fixtures) || !Array.isArray(c.groups))
    throw new Error("Invalid fixture/group configuration.");
  if (
    c.address -
      1 +
      c.fixtures.length * (c.white ? 5 : 3) +
      (c.transition === "channel" ? 1 : 0) >
    512
  )
    throw new Error("Fixture mapping exceeds one DMX universe.");
  const ids = c.fixtures.map((f) => f.id).filter(Boolean);
  if (new Set(ids).size !== ids.length)
    throw new Error("Duplicate fixture IDs are not supported.");
  if (c.mode !== "standard" && (!c.entertainmentArea || !c.bridge?.clientKey))
    throw new Error(
      "Run setup to select an Entertainment area and obtain a client key."
    );
  if (c.mode !== "standard" && c.white)
    throw new Error(
      "Entertainment currently supports RGB fixtures. Use standard mode for the legacy white channels."
    );
  return c;
}
export function saveConfig(store, config) {
  // Preserve a pristine recovery copy before the first migration.
  if (fs.existsSync(store.path) && !fs.existsSync(store.path + ".pre-v4.bak"))
    fs.copyFileSync(store.path, store.path + ".pre-v4.bak");
  store.store = config;
  try {
    fs.chmodSync(store.path, 0o600);
    if (fs.existsSync(store.path + ".pre-v4.bak"))
      fs.chmodSync(store.path + ".pre-v4.bak", 0o600);
  } catch {}
}
