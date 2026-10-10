#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import minimist from "minimist";
import inquirer from "inquirer";
import { Hue, pairBridge } from "../lib/hue.js";
import { storeConfig, migrateConfig, validateConfig } from "../lib/config.js";
import { Entertainment } from "../lib/entertainment.js";
import { listenArtNet } from "../lib/artnet.js";
import { streamTestTargets } from "../lib/stream-test-targets.js";

async function main() {
  const args = minimist(process.argv.slice(2), {
    string: ["config", "area", "source-ip"]
  });
  if (!args.config || args.help) {
    console.log(
      "Usage: node bin/stream-probe.js --config FILE [--area UUID]\nStop the normal receiver first. RGB-only Entertainment test; existing addresses retained."
    );
    return;
  }
  const config = migrateConfig(storeConfig(args.config).store);
  validateConfig(config);
  if (!config.fixtures.length)
    throw new Error("Run normal setup first to save fixture mapping.");
  const hue = new Hue({ ...config.bridge });
  if (!(await hue.ensureConnected())) throw new Error(hue.lastError);
  const areas = hue.entertainment();
  if (!areas.length)
    throw new Error(
      "Create an Entertainment area named DMX test in the Hue app, then rerun this command."
    );
  const areaId =
    args.area ||
    (
      await inquirer.prompt([
        {
          type: "list",
          name: "area",
          message: "Entertainment area to test",
          choices: areas.map((a) => ({
            name: a.metadata?.name || a.id,
            value: a.id
          }))
        }
      ])
    ).area;
  const area = areas.find((a) => a.id === areaId);
  if (!area) throw new Error("Unknown Entertainment area.");
  if (area.status === "active")
    throw new Error(
      "Area is already in use. Stop the other sync session first."
    );
  const stream = new Entertainment({
    hue,
    areaId,
    fixtureIds: config.fixtures.map((f) => f.id).filter(Boolean),
    fps: 25
  });
  stream.configure(area);
  console.log(
    "Test lights: " +
      config.fixtures
        .filter((f) => stream.lightIds.has(f.id))
        .map((f) => f.name)
        .join(", ")
  );
  console.log(
    "Other Hue lights hold their current look during this test. Use RGB scenes with Normal Fade; white-temperature looks are held, not converted. Ctrl+C ends the test."
  );
  const credentialFile = path.join(
    path.dirname(path.resolve(args.config)),
    "entertainment-test.local.json"
  );
  if (fs.existsSync(credentialFile)) {
    const saved = JSON.parse(fs.readFileSync(credentialFile, "utf8"));
    if (
      saved.id === hue.config.id &&
      saved.pin === hue.config.pin &&
      saved.clientKey
    ) {
      hue.config = { ...saved, ip: hue.config.ip };
      await hue.api("bridge");
    }
  }
  if (!hue.config.clientKey) {
    await inquirer.prompt([
      {
        name: "ready",
        message: "Press the physical Hue bridge button, then press Enter here."
      }
    ]);
    const paired = await pairBridge(hue.config.ip);
    if (paired.id !== hue.config.id || paired.pin !== hue.config.pin)
      throw new Error("Bridge identity changed during pairing.");
    fs.writeFileSync(credentialFile, JSON.stringify(paired), { mode: 0o600 });
    fs.chmodSync(credentialFile, 0o600);
    hue.config = paired;
  }
  let receiver,
    timer,
    reportTimer,
    activeTick = Promise.resolve(),
    busy = false,
    ending = false;
  let lastHealth = 0,
    whiteNotice = false,
    finish,
    fail;
  const ended = new Promise((resolve, reject) => {
    finish = resolve;
    fail = reject;
  });
  // Handle a receiver bind error even before the main wait is reached.
  ended.catch(() => {});
  const stopSignal = () => {
    ending = true;
    finish();
  };
  const stopError = (error) => {
    ending = true;
    fail(error);
  };
  process.once("SIGINT", stopSignal);
  process.once("SIGTERM", stopSignal);
  stream.onError = stopError;
  try {
    receiver = await listenArtNet({
      universe: config.universe,
      sourceIp: args["source-ip"],
      onError: stopError,
      onFrame: (frame) => {
        if (ending) return;
        const result = streamTestTargets(frame.dmx, config, stream.lightIds);
        stream.setTargets(result.entries);
        if (result.whiteHeld && !whiteNotice)
          console.log(
            "White-temperature look received: choose an RGB color on all test lights to test streaming."
          );
        whiteNotice = result.whiteHeld;
      }
    });
    console.log(
      `Listening on universe ${config.universe}. Waiting for RGB values for every test light…`
    );
    timer = setInterval(() => {
      if (busy || ending) return;
      busy = true;
      activeTick = (async () => {
        if (stream.state === "idle" && stream.ready()) {
          await stream.start();
          lastHealth = Date.now();
          console.log("Entertainment stream active at 25 frames/second.");
        }
        if (stream.state === "active" && Date.now() - lastHealth >= 5000) {
          lastHealth = Date.now();
          await stream.health();
        }
      })()
        .catch(stopError)
        .finally(() => {
          busy = false;
        });
    }, 25);
    reportTimer = setInterval(
      () =>
        console.log(
          `DMX packets: ${receiver.stats.packets}; stream: ${stream.state}; frames: ${stream.frames}`
        ),
      5000
    );
    await ended;
  } finally {
    ending = true;
    clearInterval(timer);
    clearInterval(reportTimer);
    await activeTick;
    if (receiver) await receiver.close();
    await stream.stop();
    process.removeListener("SIGINT", stopSignal);
    process.removeListener("SIGTERM", stopSignal);
  }
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
