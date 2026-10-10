import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Entertainment } from "../lib/entertainment.js";
import { mergeResource } from "../lib/events.js";
const areaId = "12345678-1234-1234-1234-123456789abc";
function harness({ failHandshake = false } = {}) {
  const actions = [],
    packets = [];
  let status = "inactive";
  let socket;
  const hue = {
    config: { ip: "127.0.0.1", key: "key", clientKey: "aa".repeat(16) },
    resources: new Map([["light", { id: "light", type: "light" }]]),
    api: async () => [
      {
        id: areaId,
        status,
        active_streamer: { rid: "our-app" },
        channels: [{ channel_id: 0, members: [{ service: { rid: "light" } }] }]
      }
    ],
    write: async (_p, body) => {
      actions.push(body.action);
      status = body.action === "start" ? "active" : "inactive";
    }
  };
  const e = new Entertainment({
    hue,
    areaId,
    fixtureIds: ["light"],
    fps: 25,
    createSocket: () => {
      socket = new EventEmitter();
      socket.send = (b, cb) => {
        packets.push(b);
        cb();
      };
      socket.close = () => socket.emit("close");
      queueMicrotask(() =>
        socket.emit(
          failHandshake ? "error" : "connected",
          new Error("handshake failed")
        )
      );
      return socket;
    }
  });
  e.setTargets(
    new Map([
      [
        "light",
        { key: "red", target: { on: true, rgb: [255, 0, 0], duration: 0 } }
      ]
    ])
  );
  return {
    e,
    actions,
    packets,
    get socket() {
      return socket;
    }
  };
}
test("stream continues exact color without new DMX input, then releases cleanly", async () => {
  const h = harness();
  await h.e.start();
  h.e.send();
  h.e.send();
  assert.ok(h.packets.length >= 3);
  assert.ok(h.packets.every((p) => p.readUInt16BE(53) === 65535));
  await h.e.stop();
  assert.deepEqual(h.actions, ["start", "stop"]);
  assert.equal(h.e.owned, false);
});
test("failed DTLS handshake releases area before standard fallback", async () => {
  const h = harness({ failHandshake: true });
  await assert.rejects(() => h.e.start(), /handshake/);
  assert.deepEqual(h.actions, ["start", "stop"]);
  assert.equal(h.e.owned, false);
});
test("stream socket loss retains ownership until explicit release", async () => {
  const h = harness();
  await h.e.start();
  h.socket.emit("error", new Error("network loss"));
  assert.equal(h.e.state, "failed");
  assert.equal(h.e.owned, true);
  await h.e.stop();
  assert.equal(h.e.owned, false);
});
test("partial state events preserve color and unrelated fields", () => {
  const merged = mergeResource(
    {
      id: "x",
      color: { xy: { x: 0.2, y: 0.3 }, gamut_type: "C" },
      on: { on: true }
    },
    { color: { xy: { x: 0.4 } } }
  );
  assert.equal(merged.color.xy.y, 0.3);
  assert.equal(merged.color.xy.x, 0.4);
  assert.equal(merged.on.on, true);
});

test("old socket events and callbacks cannot fail a replacement stream", async () => {
  const h = harness();
  await h.e.start();
  const oldSocket = h.socket;
  let callback;
  oldSocket.send = (_packet, cb) => {
    callback = cb;
  };
  h.e.send();
  await h.e.stop();
  await h.e.start();
  try {
    oldSocket.emit("error", new Error("late error"));
    oldSocket.emit("close");
    callback(new Error("late send failure"));
    assert.equal(h.e.state, "active");
    assert.equal(h.e.socket, h.socket);
    assert.equal(h.e.owned, true);
  } finally {
    await h.e.stop();
  }
});
