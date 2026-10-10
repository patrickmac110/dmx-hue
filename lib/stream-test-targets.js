import { decodeFrame, targetKey } from "./color.js";

// Preserve the original five-channel stride and speed slot. This first test
// streams RGB only: white-temperature looks hold the preceding streamed color.
export function streamTestTargets(data, config, lightIds) {
  const entries = [];
  let whiteHeld = false;
  for (const [id, target] of decodeFrame(data, config)) {
    if (!lightIds.has(id)) continue;
    if (target.on && target.mirek !== undefined) {
      whiteHeld = true;
      continue;
    }
    const immediate = { ...target, duration: 0 };
    entries.push([id, { key: targetKey(immediate), target: immediate }]);
  }
  return { entries, whiteHeld };
}
