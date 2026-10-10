import test from "node:test";
import assert from "node:assert/strict";
import { Scheduler } from "../lib/scheduler.js";
const red = { rgb: [255, 0, 0], brightness: 100, on: true, duration: 0 };
const blue = { ...red, rgb: [0, 0, 255] };
const lights = new Map(
  ["a", "b", "c"].map((id) => [id, { id, color: {}, on: { on: true } }])
);
function harness(write, groups = []) {
  let time = 0;
  const s = new Scheduler({
    write,
    lights: () => lights,
    groups: () => groups,
    now: () => time,
    interval: 100,
    refreshMs: 30000
  });
  return { s, advance: (n) => (time += n) };
}
test("failed write remains pending and identical input is retried", async () => {
  let calls = 0;
  const { s, advance } = harness(async () => {
    if (++calls === 1) throw Error("dropped");
  });
  s.set("a", red);
  await s.tick();
  s.set("a", red);
  advance(500);
  await s.tick();
  assert.equal(calls, 2);
  assert.equal(s.entries.get("a").dirty, false);
});
test("new desired color survives completion of an older request", async () => {
  let release;
  const calls = [];
  const { s, advance } = harness((path, body) => {
    calls.push(body);
    return new Promise((r) => (release = r));
  });
  s.set("a", red);
  const pending = s.tick();
  s.set("a", blue);
  release();
  await pending;
  assert.equal(s.entries.get("a").dirty, true);
  advance(100);
  const next = s.tick();
  release();
  await next;
  assert.notDeepEqual(calls[0].color, calls[1].color);
  assert.equal(s.entries.get("a").dirty, false);
});
test("32 equal targets use one group write; divergent target uses individual writes", async () => {
  const resources = new Map(
    Array.from({ length: 32 }, (_, i) => [String(i), { color: {} }])
  );
  let now = 0;
  const calls = [];
  const s = new Scheduler({
    write: async (path) => calls.push(path),
    lights: () => resources,
    groups: () => [{ id: "all", members: [...resources.keys()] }],
    now: () => now
  });
  for (const id of resources.keys()) s.set(id, red);
  await s.tick();
  assert.deepEqual(calls, ["grouped_light/all"]);
  s.set("5", blue);
  now = 1000;
  await s.tick();
  assert.equal(calls[1], "light/5");
  s.set("5", red);
  now = 2000;
  await s.tick();
  assert.equal(calls[2], "grouped_light/all");
});
test("never group across an unpatched or streaming light", async () => {
  const calls = [];
  const { s } = harness(
    async (p) => calls.push(p),
    [{ id: "all", members: ["a", "b", "c"] }]
  );
  s.set("a", red);
  s.set("b", red);
  await s.tick();
  assert.match(calls[0], /^light\//);
  s.set("c", red);
  s.excluded.add("c");
  s.nextWrite = 0;
  await s.tick();
  assert.ok(calls.every((p) => p.startsWith("light/")));
});
test("unreachable light does not starve healthy lights", async () => {
  const calls = [];
  const { s, advance } = harness(async (p) => {
    calls.push(p);
    if (p === "light/a") throw Error("unreachable");
  });
  for (const id of lights.keys()) s.set(id, red);
  for (let i = 0; i < 3; i++) {
    await s.tick();
    advance(120);
  }
  assert.deepEqual(new Set(calls), new Set(["light/a", "light/b", "light/c"]));
});
test("refresh does not require color oscillation; reconciliation waits for fade", async () => {
  let count = 0;
  const { s, advance } = harness(async () => count++);
  s.set("a", { ...red, duration: 1000 });
  await s.tick();
  s.reconcile(lights);
  assert.equal(s.entries.get("a").dirty, false);
  advance(3000);
  s.reconcile(lights);
  assert.equal(s.entries.get("a").dirty, true);
  await s.tick();
  advance(30001);
  await s.tick();
  assert.equal(count, 3);
});
test("one in-flight write protects group/individual ordering", async () => {
  let done;
  let calls = 0;
  const { s, advance } = harness(() => {
    calls++;
    return new Promise((r) => (done = r));
  });
  s.set("a", red);
  s.set("b", red);
  const first = s.tick();
  advance(1000);
  await s.tick();
  assert.equal(calls, 1);
  done();
  await first;
});
test("matching group waits for group rate limit instead of staggering individual writes", async () => {
  const calls = [];
  const { s, advance } = harness(
    async (p) => calls.push(p),
    [{ id: "all", members: ["a", "b"] }]
  );
  s.set("a", red);
  s.set("b", red);
  await s.tick();
  advance(120);
  s.set("a", blue);
  s.set("b", blue);
  await s.tick();
  assert.equal(calls.length, 1);
  advance(880);
  await s.tick();
  assert.deepEqual(calls, ["grouped_light/all", "grouped_light/all"]);
});

test("configurable group interval coalesces targets and zero retains write pacing", async () => {
  const calls = [];
  const { s, advance } = harness(
    async (p, b) => calls.push({ p, b }),
    [{ id: "all", members: ["a", "b"] }]
  );
  s.groupIntervalMs = 250;
  for (const id of ["a", "b"]) s.set(id, red);
  await s.tick();
  advance(100);
  for (const id of ["a", "b"]) s.set(id, blue);
  await s.tick();
  assert.equal(calls.length, 1);
  advance(150);
  await s.tick();
  assert.equal(calls.length, 2);
  assert.ok(calls.every((c) => c.p === "grouped_light/all"));
  advance(250);
  s.groupIntervalMs = 0;
  for (const id of ["a", "b"]) s.set(id, red);
  await s.tick();
  for (const id of ["a", "b"]) s.set(id, blue);
  advance(99);
  await s.tick();
  assert.equal(calls.length, 3);
  advance(1);
  await s.tick();
  assert.equal(calls.length, 4);
});
