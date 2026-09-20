// Hue v2 uses CIE xy plus brightness. Keep conversion deterministic for grouping.
export const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
const round = (n) => Math.round(n * 10000) / 10000;
const linear = (n) => (n > 0.04045 ? ((n + 0.055) / 1.055) ** 2.4 : n / 12.92);
export function rgbToXy(rgb) {
  const [r, g, b] = rgb.map((n) => linear(n / 255));
  const x = r * 0.664511 + g * 0.154324 + b * 0.162028;
  const y = r * 0.283881 + g * 0.668433 + b * 0.047685;
  const z = r * 0.000088 + g * 0.07231 + b * 0.986039;
  return x + y + z
    ? { x: round(x / (x + y + z)), y: round(y / (x + y + z)) }
    : { x: 0.3127, y: 0.329 };
}
export function clipXy(p, gamut) {
  if (!gamut) return p;
  const points = [gamut.red, gamut.green, gamut.blue];
  if (points.some((v) => !v)) return p;
  const cross = (a, b, c) =>
    (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  const signs = points.map((a, i) => cross(a, points[(i + 1) % 3], p));
  if (signs.every((n) => n >= 0) || signs.every((n) => n <= 0)) return p;
  const closest = points
    .map((a, i) => {
      const b = points[(i + 1) % 3],
        dx = b.x - a.x,
        dy = b.y - a.y;
      const t = clamp(
        ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1),
        0,
        1
      );
      return { x: a.x + t * dx, y: a.y + t * dy };
    })
    .sort(
      (a, b) =>
        (a.x - p.x) ** 2 +
        (a.y - p.y) ** 2 -
        ((b.x - p.x) ** 2 + (b.y - p.y) ** 2)
    )[0];
  return { x: round(closest.x), y: round(closest.y) };
}
export function decodeFrame(data, config) {
  const stride = config.white ? 5 : 3;
  let offset = config.address - 1;
  const duration =
    config.transition === "channel" ? data[offset++] * 100 : config.transition;
  if (!Number.isFinite(duration)) return [];
  const result = [];
  for (const fixture of config.fixtures) {
    if (offset + stride > data.length) break; // A short frame must not black out missing slots.
    const rgb = Array.from(data.subarray(offset, offset + 3));
    const white = config.white && rgb.every((n) => n === 0);
    const target = {
      rgb,
      duration,
      on: rgb.some((n) => n > 0),
      brightness: (Math.max(...rgb) / 255) * 100
    };
    if (white) {
      target.mirek = Math.round(153 + (data[offset + 3] / 255) * 347);
      target.brightness = (data[offset + 4] / 255) * 100;
      target.on = target.brightness > 0;
    }
    if (fixture.id) result.push([fixture.id, target]);
    offset += stride;
  }
  return result;
}
export function lightBody(target, light = {}) {
  const body = {
    on: { on: target.on },
    dynamics: { duration: target.duration }
  };
  if (!target.on) return body;
  body.dimming = {
    brightness: Math.round(clamp(target.brightness, 0.1, 100) * 100) / 100
  };
  if (target.mirek !== undefined && light.color_temperature) {
    const range = light.color_temperature.mirek_schema || {};
    body.color_temperature = {
      mirek: clamp(
        target.mirek,
        range.mirek_minimum ?? 153,
        range.mirek_maximum ?? 500
      )
    };
  } else if (light.color)
    body.color = { xy: clipXy(rgbToXy(target.rgb), light.color.gamut) };
  return body;
}
export function matchesReported(body, reported) {
  if (!reported || reported.on?.on !== body.on.on) return false;
  if (!body.on.on) return true;
  if (
    body.dimming &&
    Math.abs((reported.dimming?.brightness ?? -100) - body.dimming.brightness) >
      1
  )
    return false;
  if (
    body.color &&
    (!reported.color?.xy ||
      Math.abs(reported.color.xy.x - body.color.xy.x) > 0.004 ||
      Math.abs(reported.color.xy.y - body.color.xy.y) > 0.004)
  )
    return false;
  if (
    body.color_temperature &&
    (reported.color_temperature?.mirek_valid === false ||
      Math.abs(
        (reported.color_temperature?.mirek ?? -1000) -
          body.color_temperature.mirek
      ) > 2)
  )
    return false;
  return true;
}
export const targetKey = (target) => JSON.stringify(target);
