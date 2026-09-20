# Rewrite validation record

Version: 4.0.0-beta.1

- Local environment: Linux, Node.js 24.19.0.
- 29 automated tests passed, including actual local UDP reception and a real local HTTPS server with a generated certificate.
- HTTPS tests confirm credentials are not sent when the certificate fingerprint does not match, and a Hue error body fails the request even with HTTP 200.
- Stream tests validate v2 packet encoding and simulated DTLS lifecycle. **A real Hue Entertainment handshake has not been tested.**
- `npm audit fix --ignore-scripts` completed with zero reported vulnerabilities in the resolved dependency graph at validation time.
- GitHub Actions is configured for Node 22 and 24; those remote results are separate from the local result above.
- No connection to the church network, Pi, bridge, or bulbs was made. No physical timing, color fidelity, Zigbee delivery or 32-fixture streaming-capacity claim has been validated.
- Installation and rollback instructions are in RASPBERRY_PI.md. Complete ACCEPTANCE.md during rehearsal before production use.

The old Node 18 build matrix and upstream npm publishing workflow were replaced by the supported-version test workflow. This branch does not automatically publish an npm package.
