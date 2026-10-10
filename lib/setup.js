import inquirer from "inquirer";
import { Hue, discoverBridges, inspectBridge, pairBridge } from "./hue.js";
import {
  migrateConfig,
  mapFixtures,
  saveConfig,
  validateConfig
} from "./config.js";
import { areaChannels } from "./entertainment.js";

export async function setup(store, args) {
  const config = migrateConfig(store.store);
  let ip = args.ip || config.bridge?.ip;
  if (args.list) {
    console.table(await discoverBridges());
    return;
  }
  if (!ip) {
    const bridges = await discoverBridges();
    if (bridges.length)
      ip = (
        await inquirer.prompt([
          {
            type: "list",
            name: "ip",
            message: "Select Hue bridge",
            choices: bridges.map((b) => ({
              name: `${b.name} (${b.ip})`,
              value: b.ip
            }))
          }
        ])
      ).ip;
    else
      ip = (
        await inquirer.prompt([
          { name: "ip", message: "Hue bridge IP address:" }
        ])
      ).ip;
  }
  const identity = await inspectBridge(ip);
  if (config.bridge.id && config.bridge.id !== identity.id && !args.force)
    throw new Error(
      "This is a different bridge. Use setup --force only when intentionally replacing the bridge."
    );
  if (!config.bridge.key || args.force) {
    await inquirer.prompt([
      {
        type: "input",
        name: "ready",
        message: "Press the physical bridge button, then press Enter here."
      }
    ]);
    config.bridge = await pairBridge(ip);
  } else {
    config.bridge.ip = ip;
    // Never silently replace an existing certificate pin.
    if (config.bridge.pin && config.bridge.pin !== identity.fingerprint)
      throw new Error(
        "Certificate changed. Verify the physical bridge, then use setup --force to pair again."
      );
    config.bridge.id = identity.id;
    config.bridge.pin = identity.fingerprint;
  }
  const hue = new Hue(config.bridge);
  if (!(await hue.ensureConnected())) throw new Error(hue.lastError);
  mapFixtures(config, hue.lights());
  console.table(
    config.fixtures.map((f, i) => ({
      name: f.name,
      id: f.legacyId || f.id,
      address:
        config.address +
        i * (config.white ? 5 : 3) +
        (config.transition === "channel" ? 1 : 0)
    }))
  );
  const answers = await inquirer.prompt([
    {
      name: "universe",
      message:
        "Raw Art-Net universe (keep the existing value to preserve Luminair mapping)",
      default: config.universe,
      filter: Number
    },
    {
      name: "address",
      message: "First DMX address",
      default: config.address,
      filter: Number
    },
    {
      type: "list",
      name: "mode",
      message: "Output method",
      default: config.mode,
      choices: [
        {
          name: "Standard — all fixtures, automatic group optimization",
          value: "standard"
        },
        { name: "Entertainment — selected area only", value: "entertainment" },
        {
          name: "Mixed — selected area streams, remaining fixtures use standard",
          value: "mixed"
        }
      ]
    },
    {
      type: "confirm",
      name: "white",
      message: "Use legacy 5-channel RGB + white fixture layout?",
      default: config.white
    },
    {
      name: "transition",
      message:
        "Transition in milliseconds (0 for Luminair-driven fades), or channel",
      default: String(config.transition),
      filter: (v) => (v === "channel" ? v : Number(v))
    }
  ]);
  Object.assign(config, answers);
  if (config.legacy?.colorloop) {
    const { disable } = await inquirer.prompt([
      {
        type: "confirm",
        name: "disable",
        message:
          "Legacy RGB=1 colorloop is unsupported. Disable it and use Luminair effects?",
        default: false
      }
    ]);
    if (!disable)
      throw new Error("Setup cancelled; original configuration is unchanged.");
    config.legacy.colorloop = false;
  }
  const resources = [...hue.resources.values()];
  const available = resources.filter((r) => ["zone", "room"].includes(r.type));
  const groupAnswers = await inquirer.prompt([
    {
      type: "checkbox",
      name: "groups",
      message:
        "Groups eligible for matching-color optimization (no Hue scenes needed)",
      choices: available.map((g) => ({
        name: g.metadata?.name || g.id,
        value: g.id,
        checked: config.groups.includes(g.id)
      }))
    },
    {
      type: "confirm",
      name: "createGroup",
      message:
        "Create a Hue zone containing these DMX fixtures for whole-rig optimization?",
      default: false
    }
  ]);
  config.groups = groupAnswers.groups;
  if (config.mode !== "standard") {
    if (config.white)
      throw new Error(
        "Use RGB fixture layout for Entertainment, or retain Standard mode."
      );
    if (!config.bridge.clientKey) {
      await inquirer.prompt([
        {
          name: "ready",
          message:
            "Entertainment needs a client key. Press the bridge button, then Enter."
        }
      ]);
      config.bridge = await pairBridge(ip);
      hue.config = config.bridge;
    }
    const areas = hue.entertainment();
    if (!areas.length)
      throw new Error(
        "Create an Entertainment area in the Hue app (Settings → Entertainment areas), then rerun setup. Luminair still controls all colors/scenes."
      );
    const { area } = await inquirer.prompt([
      {
        type: "list",
        name: "area",
        message: "Entertainment area",
        choices: areas.map((a) => ({
          name: `${a.metadata?.name} (${a.channels?.length || 0} channels)`,
          value: a.id
        })),
        default: config.entertainmentArea
      }
    ]);
    config.entertainmentArea = area;
    const channels = areaChannels(
      areas.find((a) => a.id === area),
      hue.resources,
      config.fixtures.map((f) => f.id)
    );
    const ids = new Set(channels.flatMap((c) => c.lights));
    console.log(
      `Entertainment: ${ids.size}/${config.fixtures.length} fixtures, ${channels.length} channels.`
    );
    if (
      config.mode === "entertainment" &&
      config.fixtures.some((f) => !ids.has(f.id))
    )
      throw new Error(
        "Entertainment-only mode must cover every configured fixture. Select Mixed for partial coverage."
      );
  }
  validateConfig(config);
  if (groupAnswers.createGroup) {
    // Zones contain light resources; rooms contain device resources.
    const lights = config.fixtures
      .map((f) => f.id)
      .filter((id) => hue.resources.get(id)?.type === "light");
    if (!lights.length) throw new Error("No lights available to create a zone");
    const created = await hue.api("zone", {
      method: "POST",
      body: {
        metadata: { name: "DMX Hue fixtures", archetype: "other" },
        children: lights.map((rid) => ({ rid, rtype: "light" }))
      }
    });
    if (created[0]?.rid) config.groups.push(created[0].rid);
  }
  saveConfig(store, config);
  console.log(
    `Saved ${store.path}. Start with dmx-hue. Original configuration is backed up beside this file.`
  );
}
