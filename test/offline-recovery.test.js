import test from "node:test";
import assert from "node:assert/strict";
import { Scheduler } from "../lib/scheduler.js";
import { Hue } from "../lib/hue.js";
import { mapFixtures } from "../lib/config.js";
const red = { rgb: [255, 0, 0], brightness: 100, on: true, duration: 0 };
const blue = { ...red, rgb: [0, 0, 255] };
function fixture({ groups = [], write = async () => {} } = {}) {
  let time = 0;
  const states = new Map([
    ["a", "connected"],
    ["b", "disconnected"],
    ["c", "disconnected"]
  ]);
  const lights = new Map(
    ["a", "b", "c"].map((id) => [id, { id, type: "light", color: {} }])
  );
  const calls = [];
  const scheduler = new Scheduler({
    now: () => time,
    lights: () => lights,
    connectivity: () => states,
    groups: () => groups,
    write: async (path, body) => {
      calls.push({ time, path, body });
      await write(path, body);
    }
  });
  return {
    scheduler,
    states,
    calls,
    advance: (n) => {
      time += n;
    }
  };
}
test("offline HTTP success still retries at 0.5, 1 and 2 seconds; live cue is prioritized", async () => {
  const { scheduler: s, calls, advance } = fixture();
  s.set("b", red);
  await s.tick();
  assert.equal(s.entries.get("b").dirty, true);
  advance(499);
  await s.tick();
  assert.equal(calls.length, 1);
  advance(1);
  await s.tick();
  advance(1000);
  await s.tick();
  advance(2000);
  await s.tick();
  assert.deepEqual(
    calls.map((c) => c.time),
    [0, 500, 1500, 3500]
  );
  s.set("a", blue);
  advance(120);
  await s.tick();
  assert.equal(calls.at(-1).path, "light/a");
});
test("offline retry budget is shared and restoration sends latest target without new DMX", async () => {
  const { scheduler: s, states, calls, advance } = fixture();
  s.set("b", red);
  s.set("c", red);
  await s.tick();
  advance(120);
  await s.tick();
  assert.equal(calls.length, 1);
  advance(380);
  await s.tick();
  assert.equal(calls.length, 2);
  s.set("b", blue);
  states.set("b", "connected");
  s.updateConnectivity();
  advance(120);
  await s.tick();
  assert.equal(calls.at(-1).path, "light/b");
  assert.equal(s.entries.get("b").dirty, false);
  assert.deepEqual(s.entries.get("b").target.rgb, [0, 0, 255]);
});
test("offline member does not block healthy group cues or cause group retry storms", async () => {
  const {
    scheduler: s,
    calls,
    advance
  } = fixture({ groups: [{ id: "group", members: ["a", "b"] }] });
  s.set("a", red);
  s.set("b", red);
  await s.tick();
  assert.equal(calls[0].path, "grouped_light/group");
  advance(500);
  await s.tick();
  assert.equal(calls[1].path, "light/b");
  s.set("a", blue);
  s.set("b", blue);
  advance(500);
  await s.tick();
  assert.equal(calls[2].path, "grouped_light/group");
  assert.equal(s.entries.get("a").dirty, false);
});
test("partial group failure retries the named bulb without delaying healthy members", async () => {
  const {
    scheduler: s,
    states,
    calls,
    advance
  } = fixture({
    groups: [{ id: "group", members: ["a", "b"] }],
    write: async (path) => {
      if (path.startsWith("grouped_light")) throw Error("b");
    }
  });
  states.set("b", "connected");
  s.set("a", red);
  s.set("b", red);
  await s.tick();
  assert.equal(s.entries.get("a").dirty, false);
  assert.equal(s.entries.get("b").dirty, true);
  advance(500);
  await s.tick();
  assert.equal(calls.at(-1).path, "light/b");
});
test("restoring temporary disabled IDs preserves missing slots and all addresses", () => {
  const c = {
    fixtures: [{ id: "a" }, { id: null, disabledId: "cross" }, { id: null }]
  };
  assert.equal(mapFixtures(c, new Map()), true);
  assert.deepEqual(c.fixtures, [{ id: "a" }, { id: "cross" }, { id: null }]);
  assert.equal(mapFixtures(c, new Map()), false);
});
test("device connectivity resources map to the correct light IDs", () => {
  const h = new Hue({});
  h.resources = new Map([
    ["l", { id: "l", type: "light", owner: { rid: "d" } }],
    [
      "z",
      {
        id: "z",
        type: "zigbee_connectivity",
        owner: { rid: "d" },
        status: "disconnected"
      }
    ]
  ]);
  assert.equal(h.connectivity().get("l"), "disconnected");
});
