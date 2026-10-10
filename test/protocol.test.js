import test from "node:test";
import assert from "node:assert/strict";
import dgram from "node:dgram";
import { parseDmx, pollReply, listenArtNet } from "../lib/artnet.js";
import { decodeFrame, clipXy, lightBody } from "../lib/color.js";
import {
  encodeStream,
  areaChannels,
  Entertainment
} from "../lib/entertainment.js";
import { mapFixtures, migrateConfig, validateConfig } from "../lib/config.js";
function packet(universe, sequence = 1, values = [255, 0, 0, 0]) {
  const b = Buffer.alloc(18 + values.length);
  b.write("Art-Net\0");
  b.writeUInt16LE(0x5000, 8);
  b.writeUInt16BE(14, 10);
  b[12] = sequence;
  b.writeUInt16LE(universe, 14);
  b.writeUInt16BE(values.length, 16);
  Buffer.from(values).copy(b, 18);
  return b;
}
test("malformed Art-Net packets are discarded without exceptions", () => {
  for (let n = 0; n < 18; n++) assert.equal(parseDmx(Buffer.alloc(n)), null);
  const b = packet(2);
  b.writeUInt16BE(512, 16);
  assert.equal(parseDmx(b), null);
  assert.equal(parseDmx(packet(2)).universe, 2);
});
test("poll reply advertises actual net/subnet/universe and output capability", () => {
  const b = pollReply(0x1234, {
    address: "192.168.1.9",
    mac: "00:11:22:33:44:55"
  });
  assert.equal(b[18], 0x12);
  assert.equal(b[19], 3);
  assert.equal(b[190], 4);
  assert.equal(b[174], 0x80);
  assert.equal(b[182], 0x80);
});
test("UDP listener filters universes, duplicates, stale frames; accepts disabled sequencing", async () => {
  const frames = [];
  const receiver = await listenArtNet({
    host: "127.0.0.1",
    universe: 2,
    onFrame: (f) => frames.push(f)
  });
  const client = dgram.createSocket("udp4");
  try {
    for (const b of [
      packet(1),
      packet(2, 254),
      packet(2, 255),
      packet(2, 1),
      packet(2, 1),
      packet(2, 255),
      packet(2, 0),
      packet(2, 1),
      Buffer.alloc(1)
    ])
      await new Promise((r, j) =>
        client.send(b, 6454, "127.0.0.1", (e) => (e ? j(e) : r()))
      );
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(
      frames.map((f) => f.sequence),
      [254, 255, 1, 0, 1]
    );
  } finally {
    client.close();
    await receiver.close();
  }
});
test("short DMX frames leave omitted fixtures unchanged and reserve missing slots", () => {
  const c = {
    address: 1,
    white: false,
    transition: 0,
    fixtures: [{ id: "a" }, { id: null }, { id: "c" }]
  };
  assert.equal(
    decodeFrame(Buffer.from([255, 0, 0, 0, 0, 0, 0, 0]), c).length,
    1
  );
  assert.deepEqual(
    decodeFrame(Buffer.from([255, 0, 0, 0, 0, 0, 0, 0, 255]), c)[1][1].rgb,
    [0, 0, 255]
  );
});
test("mapping preserves legacy order and remains stable when a light disappears", () => {
  const c = migrateConfig({
    lightsOrder: [3, 1],
    disabledLights: { 2: true },
    universe: 2
  });
  const all = new Map(
    [1, 2, 3].map((n) => [
      String(n),
      { id: String(n), id_v1: `/lights/${n}`, metadata: { name: String(n) } }
    ])
  );
  mapFixtures(c, all);
  assert.deepEqual(
    c.fixtures.map((f) => f.id),
    ["3", "1"]
  );
  all.delete("3");
  mapFixtures(c, all);
  assert.equal(c.fixtures[0].id, "3");
});
test("configuration rejects channel overflow and incomplete streaming setup", () => {
  const c = migrateConfig({});
  c.fixtures = Array.from({ length: 171 }, (_, i) => ({ id: String(i) }));
  assert.throws(() => validateConfig(c), /exceeds/);
  c.fixtures = [];
  c.mode = "entertainment";
  assert.throws(() => validateConfig(c), /client key/);
});
test("color conversion clips to fixture gamut and maps white temperature range", () => {
  assert.deepEqual(
    clipXy(
      { x: 1, y: 1 },
      { red: { x: 1, y: 0 }, green: { x: 0, y: 1 }, blue: { x: 0, y: 0 } }
    ),
    { x: 0.5, y: 0.5 }
  );
  const body = lightBody(
    { on: true, brightness: 50, mirek: 500, duration: 0 },
    {
      color_temperature: {
        mirek_schema: { mirek_minimum: 200, mirek_maximum: 400 }
      }
    }
  );
  assert.equal(body.color_temperature.mirek, 400);
});
test("Entertainment v2 wire packet uses ASCII UUID, 8-bit channel and 16-bit RGB", () => {
  const id = "12345678-1234-1234-1234-123456789abc";
  const b = encodeStream(id, [{ id: 7, rgb: [255, 128, 0] }], 257);
  assert.equal(b.length, 59);
  assert.equal(b.subarray(0, 9).toString(), "HueStream");
  assert.equal(b[9], 2);
  assert.equal(b[11], 1);
  assert.equal(b.subarray(16, 52).toString(), id);
  assert.equal(b[52], 7);
  assert.equal(b.readUInt16BE(53), 65535);
  assert.equal(b.readUInt16BE(55), 32896);
  assert.equal(b.readUInt16BE(57), 0);
});
test("Entertainment resolves service IDs to patched fixture IDs and refuses unpatched members", () => {
  const resources = new Map([
    ["e", { type: "entertainment", renderer: true, owner: { rid: "d" } }],
    ["d", { services: [{ rtype: "light", rid: "l" }] }]
  ]);
  const area = {
    channels: [{ channel_id: 0, members: [{ service: { rid: "e" } }] }]
  };
  assert.deepEqual(areaChannels(area, resources, ["l"]), [
    { id: 0, lights: ["l"] }
  ]);
  assert.throws(() => areaChannels(area, resources, []), /Every light/);
});
test("Entertainment refuses an existing active stream without writing", async () => {
  let writes = 0;
  const hue = {
    resources: new Map([["l", { id: "l", type: "light" }]]),
    api: async () => [
      {
        status: "active",
        channels: [{ channel_id: 0, members: [{ service: { rid: "l" } }] }]
      }
    ],
    write: async () => writes++
  };
  const e = new Entertainment({ hue, areaId: "x", fixtureIds: ["l"] });
  e.setTargets(
    new Map([
      ["l", { key: "r", target: { on: true, rgb: [255, 0, 0], duration: 0 } }]
    ])
  );
  await assert.rejects(() => e.start(), /already active/);
  assert.equal(writes, 0);
});
