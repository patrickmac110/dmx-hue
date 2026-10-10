# Raspberry Pi installation and rollback

Do this during a maintenance window, not immediately before a service.

## 1. Preserve the existing installation

Record the command/service currently used to start dmx-hue, the service user, the installed Node version, and the current configuration location. Keep the old install in place while testing this separate checkout. Do not run both receivers simultaneously.

The rewrite uses the same `conf` project name. Setup copies the original configuration to `config.json.pre-v4.bak` (the exact path is printed). Keep an additional offline copy if desired. If the old service ran as root, running setup as another user will not find its configuration: use an explicit configuration path or intentionally copy it to the service user's configuration directory with mode 600.

## 2. Install a separate checkout

Install a supported Node.js version (22 or newer) suitable for your Pi's architecture. Then:

```sh
git clone --branch rewrite/reliable-hue-v2 https://github.com/patrickmac110/dmx-hue.git dmx-hue-v4
cd dmx-hue-v4
npm ci
npm test
node bin/dmx-hue.js setup
```

Keep the existing raw universe/address values. The program preserves the old light ordering when migrating, then stores explicit v2 IDs. Check the printed table against Luminair before operating lights.

Start with **Standard** mode. For the 32 matching downlights, allow setup to create/select a zone containing all patched fixtures. This enables live group optimization without defining any Hue scenes. If fixtures differ, their targets automatically use individual control.

If the bridge's last saved address no longer works, specify its current address with `setup --ip <address>`. This first successful migration records the permanent bridge ID used for later automatic local discovery.

## 3. Test manually

Stop the old receiver/service, then start the rewrite in a terminal:

```sh
node bin/dmx-hue.js --dashboard-host 0.0.0.0
```

Visit `http://<Pi-IP>:8080` from the iPad on the same LAN. Check packets increase on Luminair changes and the expected raw universe is displayed. Test all-light changes, individual colors, fades, blackout and recovery. The tests do not connect to your church hardware.

Reserve DHCP addresses in the router for the bridge, Pi, and Art-Net node. Luminair may continue broadcasting; there is no need to target the Pi by IP. A Pi reservation makes the status page easier to find. A bridge reservation reduces rediscovery delays, but the application also recovers automatically by bridge ID.

## 4. Optional Entertainment setup

Create an Entertainment area in the Hue app, then rerun setup and choose Mixed. Setup reports the actual fixtures covered by that area. The rest remain on Standard control. All fixtures remain programmed in Luminair. You may need to press the Hue bridge button once to obtain an Entertainment client key.

A single bridge's limit still applies. No promise is made that 32 physical downlights can stream together. Use the area membership the bridge actually permits. Start in a rehearsal and compare colors/brightness and fade behavior to Standard mode.

## 5. Automatic startup

An example service is in `deploy/dmx-hue.service`. Edit **User**, **WorkingDirectory**, and **ExecStart** for the Pi. `ExecStart` must use the absolute path of a compatible Node executable (find it with `command -v node`). Do not rely on an interactive shell's nvm initialization.

```sh
sudo cp deploy/dmx-hue.service /etc/systemd/system/dmx-hue-v4.service
sudo systemctl daemon-reload
sudo systemctl enable --now dmx-hue-v4.service
sudo systemctl status dmx-hue-v4.service
journalctl -u dmx-hue-v4.service -n 100 --no-pager
```

Disable the old service's auto-start before enabling this one. The service waits for networking and restarts on application failure; the program itself tolerates the bridge/router being unavailable at startup. Its configuration directory must be writable by its service user so new bridge addresses can be saved.

## Rollback

1. Stop and disable `dmx-hue-v4.service`.
2. Restore the original configuration from its `.pre-v4.bak` copy to the original path, preserving ownership and permissions.
3. Restart the previous dmx-hue installation/service using its original command.
4. Confirm Luminair control. Keep the v4 checkout/logs for diagnosis.

No firmware or physical bulb settings are automatically changed by installation. Setup only creates a Hue zone when you choose that option. Pairing creates an additional credential; it does not remove existing ones.
