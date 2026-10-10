import test from "node:test";
import assert from "node:assert/strict";
import { streamTestTargets } from "../lib/stream-test-targets.js";
test("streaming test retains speed and white channel slots, follows RGB without extra fade", () => {
  const c = {
    address: 1,
    transition: "channel",
    white: true,
    fixtures: [{ id: "a" }, { id: null }, { id: "b" }]
  };
  const data = Buffer.from([
    20, 255, 0, 0, 100, 200, 0, 0, 255, 100, 200, 0, 255, 0, 100, 200
  ]);
  const { entries } = streamTestTargets(data, c, new Set(["b"]));
  assert.equal(entries.length, 1);
  assert.equal(entries[0][0], "b");
  assert.deepEqual(entries[0][1].target.rgb, [0, 255, 0]);
  assert.equal(entries[0][1].target.duration, 0);
});
test("streaming test holds unsupported whites, permits blackout, and ignores short slots", () => {
  const c = {
    address: 1,
    transition: "channel",
    white: true,
    fixtures: [{ id: "a" }]
  };
  const ids = new Set(["a"]);
  assert.equal(
    streamTestTargets(Buffer.from([0, 0, 0, 0, 127, 255]), c, ids).whiteHeld,
    true
  );
  assert.equal(
    streamTestTargets(Buffer.from([0, 0, 0, 0, 127, 255]), c, ids).entries
      .length,
    0
  );
  const off = streamTestTargets(Buffer.from([0, 0, 0, 0, 127, 0]), c, ids);
  assert.equal(off.entries[0][1].target.on, false);
  assert.equal(
    streamTestTargets(Buffer.from([0, 255, 0]), c, ids).entries.length,
    0
  );
});
