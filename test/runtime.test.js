import test from "node:test";
import assert from "node:assert/strict";
import { DmxHue } from "../index.js";
import { Scheduler } from "../lib/scheduler.js";

test("full runtime maps DMX into one group and preserves latest targets through outage", async () => {
  const app = new DmxHue(["--no-dashboard"]);
  const calls = [];
  let online = true;
  const fixtures = Array.from({ length: 32 }, (_, i) => ({
    id: String(i),
    name: String(i)
  }));
  const resources = new Map(
    fixtures.map((f) => [f.id, { id: f.id, type: "light", color: {} }])
  );
  app.config = {
    address: 1,
    universe: 2,
    transition: 0,
    white: false,
    mode: "standard",
    fixtures
  };
  app.hue = { ensureConnected: async () => online, lights: () => resources };
  app.lastSnapshot = Date.now();
  app.scheduler = new Scheduler({
    write: async (p, b) => calls.push({ p, b }),
    lights: () => resources,
    groups: () => [{ id: "all", members: fixtures.map((f) => f.id) }]
  });
  const frame = (rgb) => ({ dmx: Buffer.from(fixtures.flatMap(() => rgb)) });
  app.accept(frame([255, 0, 0]));
  await app.tick();
  assert.equal(calls[0].p, "grouped_light/all");
  online = false;
  app.accept(frame([0, 0, 255]));
  await app.tick();
  assert.equal(calls.length, 1);
  online = true;
  app.scheduler.nextWrite = 0;
  app.scheduler.nextGroup = 0;
  await app.tick();
  assert.equal(calls.length, 2);
  assert.notDeepEqual(calls[0].b.color, calls[1].b.color);
});
test("runtime suppresses REST writes to fixtures streamed by another app", async () => {
  const app = new DmxHue([]);
  let calls = 0;
  const resources = new Map([
    ["a", { id: "a", type: "light", color: {}, mode: "streaming" }]
  ]);
  app.config = {
    address: 1,
    transition: 0,
    white: false,
    mode: "standard",
    fixtures: [{ id: "a" }]
  };
  app.hue = { ensureConnected: async () => true, lights: () => resources };
  app.lastSnapshot = Date.now();
  app.scheduler = new Scheduler({
    write: async () => calls++,
    lights: () => resources
  });
  app.accept({ dmx: Buffer.from([255, 0, 0]) });
  await app.tick();
  assert.equal(calls, 0);
  resources.get("a").mode = "normal";
  await app.tick();
  assert.equal(calls, 1);
});
