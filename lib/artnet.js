import os from "node:os";
import dgram from "node:dgram";
const HEADER = Buffer.from("Art-Net\0");
export function parseDmx(message) {
  if (
    message.length < 18 ||
    !message.subarray(0, 8).equals(HEADER) ||
    message.readUInt16LE(8) !== 0x5000 ||
    message.readUInt16BE(10) < 14
  )
    return null;
  const length = message.readUInt16BE(16);
  if (length < 2 || length > 512 || length % 2 || message.length < 18 + length)
    return null;
  return {
    sequence: message[12],
    universe: message.readUInt16LE(14),
    dmx: message.subarray(18, 18 + length)
  };
}
export function pollReply(universe, itf) {
  const b = Buffer.alloc(239);
  HEADER.copy(b);
  b.writeUInt16LE(0x2100, 8);
  itf.address.split(".").forEach((n, i) => (b[10 + i] = Number(n)));
  b.writeUInt16LE(6454, 14);
  b.writeUInt16BE(4, 16);
  b[18] = (universe >> 8) & 127;
  b[19] = (universe >> 4) & 15;
  b[23] = 0x20;
  b.write("DMX Hue v2", 26, 18);
  b.write("Reliable Hue Art-Net bridge", 44, 64);
  b.write("#0001 [0000] Ready", 108, 64);
  b.writeUInt16BE(1, 172);
  b[174] = 0x80;
  b[182] = 0x80;
  b[190] = universe & 15;
  (itf.mac || "00:00:00:00:00:00")
    .split(":")
    .forEach((n, i) => (b[201 + i] = parseInt(n, 16)));
  b.copy(b, 207, 10, 14);
  b[211] = 1;
  b[212] = 0x08;
  return b;
}
export function listenArtNet({
  host = "0.0.0.0",
  universe = 0,
  sourceIp,
  onFrame,
  onError = console.error
}) {
  const socket = dgram.createSocket("udp4");
  const sequences = new Map();
  let activeSource = null,
    lastPacket = 0;
  const stats = {
    packets: 0,
    ignored: 0,
    malformed: 0,
    lastFrameAt: 0,
    source: null
  };
  socket.on("error", onError);
  socket.on("message", (message, peer) => {
    if (message.length < 12 || !message.subarray(0, 8).equals(HEADER)) {
      stats.malformed++;
      return;
    }
    const opcode = message.readUInt16LE(8);
    if (
      opcode === 0x2000 &&
      message.length >= 14 &&
      message.readUInt16BE(10) >= 14
    ) {
      const interfaces = Object.values(os.networkInterfaces())
        .flat()
        .filter(
          (i) =>
            !i.internal &&
            i.family === "IPv4" &&
            (host === "0.0.0.0" || host === i.address)
        );
      for (const itf of interfaces)
        socket.send(pollReply(universe, itf), 6454, peer.address, (error) => {
          if (error) onError(error);
        });
      return;
    }
    const frame = parseDmx(message);
    if (!frame) {
      stats.malformed++;
      return;
    }
    if (
      frame.universe !== universe ||
      (sourceIp && peer.address !== sourceIp)
    ) {
      stats.ignored++;
      return;
    }
    const now = Date.now();
    // Lock to one source until it has been silent for 3s. No accidental controller merging.
    if (
      activeSource &&
      activeSource !== peer.address &&
      now - lastPacket < 3000
    ) {
      stats.ignored++;
      return;
    }
    const previous = sequences.get(peer.address);
    if (frame.sequence && previous && now - previous.time < 3000) {
      const delta = (frame.sequence - previous.sequence + 256) % 256;
      if (delta === 0 || delta > 127) {
        stats.ignored++;
        return;
      }
    }
    // Sequence 0 explicitly disables sequencing, including a previously enabled sequence.
    if (frame.sequence)
      sequences.set(peer.address, { sequence: frame.sequence, time: now });
    else sequences.delete(peer.address);
    if (sequences.size > 32) sequences.delete(sequences.keys().next().value);
    activeSource = peer.address;
    lastPacket = now;
    stats.packets++;
    stats.lastFrameAt = now;
    stats.source = peer.address;
    onFrame(frame);
  });
  return new Promise((resolve, reject) => {
    socket.once("error", reject);
    socket.bind(6454, host, () => {
      socket.removeListener("error", reject);
      resolve({
        socket,
        stats,
        close: () => new Promise((r) => socket.close(r))
      });
    });
  });
}
