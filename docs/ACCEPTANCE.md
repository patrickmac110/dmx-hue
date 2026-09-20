# Validation and church rehearsal

## Automated

Run `npm ci`, `npm test`, and `npm run format:check` on supported Node. Tests use fake bridge resources and local UDP; no church credentials are needed. DTLS lifecycle tests mock the transport, so they verify our state machine and bytes, not a real Hue DTLS handshake.

The meaningful checks cover:

- Failure followed by unchanged DMX still retries.
- An old successful request cannot erase a newer target.
- 32 identical targets use one eligible group; individual divergence is preserved.
- Group throttling does not cause unintended staggered individual updates.
- An unavailable bulb does not starve other individual targets.
- No overlapping writes; transition settling and periodic exact-state refresh.
- Short/malformed Art-Net packets; universe filtering, duplicate/out-of-order sequences, sequence wrap and sequence-zero mode.
- Stable slot mapping after migration and disappearance; channel capacity bounds.
- Bridge identity discovery after changed DHCP address, wrong-bridge rejection, delayed startup recovery.
- Entertainment v2 packet fields; service-to-fixture mapping; refusal of another active stream.
- Continuous same-color streaming; handshake failure and socket-loss release behavior.
- Partial event updates preserve unrelated resource fields.

## Physical acceptance (not performed remotely)

1. Record Pi model, OS/architecture, Node version, bridge model/firmware and bulb firmware.
2. Confirm fixture mapping and raw universe against the existing system.
3. Change all 32 to red, green, blue, white, dim and off. Repeat at least 20 times with the old oscillation workaround disabled. Record any missed bulb, API errors and response spread.
4. Give one fixture a different color, then reunify all targets. Verify no stale individual command overrides the group.
5. Compare Luminair-driven fades with transition set to zero. Standard group updates are rate-limited; assess whether they meet the desired visual smoothness.
6. Disconnect one bulb's power, continue control, then restore it. Check it converges and other lights keep responding.
7. Restart the router, bridge and Pi in different orders. When practical, change the bridge's DHCP lease intentionally. Verify recovery without pairing and with the same patch. Check that the mDNS service is not filtered between devices.
8. Stop Luminair: the last look should hold. Relaunch it and verify the latest cue takes over. Power-cycle the Pi: it should wait for live targets rather than replay an old persisted look.
9. Test Entertainment on the permitted area. Confirm DTLS handshake, compatible bulb membership, RGB/brightness match and continuous output. Compare physical smoothness to the reported transmission rate.
10. End or interrupt a stream and verify Standard fallback and recovery, with a visible status. Confirm an active stream from another app is not seized and REST output does not fight it.
11. Stop the new service, restore the original configuration, and verify the rollback works before relying on the new installation.

A matching bridge state is not proof of emitted light. Observe physical bulbs while testing. Log actual results rather than assuming a particular improvement factor or Entertainment fixture capacity.
