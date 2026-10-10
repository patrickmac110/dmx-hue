import test from "node:test";
import assert from "node:assert/strict";
import { Hue } from "../lib/hue.js";

test("changed DHCP address rediscovers same bridge and reuses credentials", async () => {
  const config = {
    ip: "192.168.1.5",
    id: "ABCDEF1234567890",
    key: "existing-key",
    pin: "fingerprint"
  };
  let saved = false;
  const h = new Hue(config, {
    save: () => (saved = true),
    discover: async () => [
      { id: "OTHER", ip: "192.168.1.6" },
      { id: config.id, ip: "192.168.1.8" }
    ],
    request: async (creds, path) => {
      assert.equal(creds.key, "existing-key");
      assert.equal(creds.pin, "fingerprint");
      if (creds.ip !== "192.168.1.8") throw Error("offline");
      return {
        fingerprint: "fingerprint",
        payload:
          path === "/api/config"
            ? { bridgeid: config.id, modelid: "BSB002" }
            : { data: [{ id: "a", type: "light" }] }
      };
    }
  });
  assert.equal(await h.ensureConnected(), true);
  assert.equal(config.ip, "192.168.1.8");
  assert.equal(saved, true);
  assert.equal(h.lights().size, 1);
});
test("discovery does not select an unrelated bridge", async () => {
  let attempted = false;
  const h = new Hue(
    { id: "AAAA", ip: "old", key: "key" },
    {
      discover: async () => [{ id: "BBBB", ip: "new" }],
      request: async (c) => {
        if (c.ip === "new") attempted = true;
        throw Error("offline");
      }
    }
  );
  assert.equal(await h.ensureConnected(), false);
  assert.equal(attempted, false);
});
test("bridge startup outage is recoverable without losing configuration", async () => {
  let online = false;
  const c = { id: "AAAA", ip: "old", key: "key" };
  const h = new Hue(c, {
    discover: async () => [],
    request: async (_c, path) => {
      if (!online) throw Error("offline");
      return {
        fingerprint: "pin",
        payload: path === "/api/config" ? { bridgeid: "AAAA" } : { data: [] }
      };
    }
  });
  assert.equal(await h.ensureConnected(), false);
  online = true;
  h.nextConnect = 0;
  assert.equal(await h.ensureConnected(), true);
  assert.equal(c.key, "key");
});

test("periodic snapshots use the same resource endpoint as initial connection", async () => {
  let polls = 0;
  const h = new Hue(
    { id: "AAAA", ip: "bridge", key: "key" },
    {
      discover: async () => [],
      request: async (_credentials, path) => {
        if (path === "/api/config")
          return { fingerprint: "pin", payload: { bridgeid: "AAAA" } };
        if (path === "/clip/v2/resource") {
          polls++;
          return {
            payload: {
              data: [{ id: "a", type: "light", on: { on: polls > 1 } }]
            }
          };
        }
        throw Error("Not Found");
      }
    }
  );
  assert.equal(await h.ensureConnected(), true);
  assert.equal(await h.snapshot(), true);
  assert.equal(h.connected, true);
  assert.equal(h.lights().get("a").on.on, true);
  assert.equal(await h.snapshot(), true);
  assert.equal(polls, 3);
});
