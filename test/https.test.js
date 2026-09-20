import test from "node:test";
import assert from "node:assert/strict";
import https from "node:https";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { requestHue } from "../lib/hue.js";

test("HTTPS validates certificate before sending credentials and handles Hue body errors", async (t) => {
  try {
    execFileSync("openssl", ["version"], { stdio: "ignore" });
  } catch {
    t.skip("openssl is needed to generate an ephemeral test certificate");
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dmx-hue-tls-"));
  let server;
  try {
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        path.join(dir, "key.pem"),
        "-out",
        path.join(dir, "cert.pem"),
        "-days",
        "1",
        "-subj",
        "/CN=ABCDEF1234567890"
      ],
      { stdio: "ignore" }
    );
    const cert = fs.readFileSync(path.join(dir, "cert.pem"));
    const pin = new X509Certificate(cert).fingerprint256;
    let requests = 0;
    server = https.createServer(
      { key: fs.readFileSync(path.join(dir, "key.pem")), cert },
      (req, res) => {
        requests++;
        assert.equal(req.headers["hue-application-key"], "secret");
        res.setHeader("Content-Type", "application/json");
        res.end(
          req.url === "/error"
            ? JSON.stringify({
                data: [],
                errors: [{ description: "device unavailable" }]
              })
            : JSON.stringify({ data: [], errors: [] })
        );
      }
    );
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const credentials = {
      ip: "127.0.0.1",
      port: server.address().port,
      key: "secret",
      bridgeId: "ABCDEF1234567890",
      pin
    };
    await assert.rejects(
      () => requestHue({ ...credentials, pin: "wrong" }, "/"),
      /certificate/
    );
    assert.equal(requests, 0);
    await requestHue(credentials, "/");
    assert.equal(requests, 1);
    await assert.rejects(
      () => requestHue(credentials, "/error"),
      /device unavailable/
    );
  } finally {
    if (server) await new Promise((r) => server.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
