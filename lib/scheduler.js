import { lightBody, matchesReported, targetKey } from "./color.js";

// A single in-flight write prevents old individual writes overtaking new group writes.
export class Scheduler {
  constructor({
    write,
    lights = () => new Map(),
    groups = () => [],
    now = Date.now,
    interval = 120,
    groupIntervalMs = 1000,
    refreshMs = 30000,
    onError = () => {}
  }) {
    Object.assign(this, {
      write,
      lights,
      groups,
      now,
      interval,
      groupIntervalMs,
      refreshMs,
      onError
    });
    this.entries = new Map();
    this.excluded = new Set();
    this.busy = false;
    this.nextWrite = 0;
    this.nextGroup = 0;
    this.cursor = 0;
    this.stats = { writes: 0, groupWrites: 0, failures: 0 };
  }
  set(id, target) {
    const old = this.entries.get(id),
      key = targetKey(target);
    if (old?.key === key) return;
    this.entries.set(id, {
      ...old,
      target,
      key,
      revision: (old?.revision ?? 0) + 1,
      dirty: true,
      due: old?.due ?? 0,
      failures: old?.failures ?? 0
    });
  }
  reapply() {
    for (const e of this.entries.values()) {
      e.dirty = true;
      e.due = 0;
    }
  }
  reconcile(resources) {
    const now = this.now();
    for (const [id, e] of this.entries) {
      if (e.dirty || this.excluded.has(id) || now < (e.settleAt ?? Infinity))
        continue;
      const light = resources.get(id);
      if (light && !matchesReported(lightBody(e.target, light), light))
        e.dirty = true;
    }
  }
  async tick() {
    const now = this.now();
    if (this.busy || now < this.nextWrite) return;
    const resources = this.lights();
    const all = [...this.entries].filter(
      ([id]) => !this.excluded.has(id) && resources.has(id)
    );
    const pending = ([, e]) =>
      now >= e.due &&
      (e.dirty ||
        (this.refreshMs > 0 &&
          now >= (e.lastSuccess ?? Infinity) + this.refreshMs));
    if (!all.some(pending)) return;
    let selected, path, body;
    const deferred = new Set();
    {
      for (const group of [...this.groups()].sort(
        (a, b) => b.members.length - a.members.length
      )) {
        if (
          group.members.length < 2 ||
          group.members.some(
            (id) =>
              this.excluded.has(id) ||
              !this.entries.has(id) ||
              !resources.has(id)
          )
        )
          continue;
        const members = group.members.map((id) => [id, this.entries.get(id)]);
        if (!members.some(pending) || members.some(([, e]) => e.due > now))
          continue;
        const bodies = members.map(([id, e]) =>
          lightBody(e.target, resources.get(id))
        );
        if (
          !bodies.every((b) => JSON.stringify(b) === JSON.stringify(bodies[0]))
        )
          continue;
        if (now < this.nextGroup) {
          for (const [id] of members) deferred.add(id);
          continue;
        }
        selected = members;
        body = bodies[0];
        path = `grouped_light/${group.id}`;
        break;
      }
    }
    if (!selected) {
      for (let i = 0; i < all.length; i++) {
        const pos = (this.cursor + i) % all.length;
        if (deferred.has(all[pos][0]) || !pending(all[pos])) continue;
        selected = [all[pos]];
        this.cursor = (pos + 1) % all.length;
        break;
      }
      if (!selected) return;
      const [id, e] = selected[0];
      body = lightBody(e.target, resources.get(id));
      path = `light/${id}`;
    }
    const revisions = selected.map(([id, e]) => [id, e.revision]);
    this.busy = true;
    this.nextWrite = now + this.interval;
    if (selected.length > 1) this.nextGroup = now + this.groupIntervalMs;
    try {
      await this.write(path, body);
      this.stats.writes++;
      if (selected.length > 1) this.stats.groupWrites++;
      for (const [id, revision] of revisions) {
        const e = this.entries.get(id);
        if (e.revision !== revision) continue;
        e.dirty = false;
        e.failures = 0;
        e.due = 0;
        e.lastSuccess = this.now();
        e.settleAt = this.now() + e.target.duration + 1500;
      }
    } catch (error) {
      this.stats.failures++;
      for (const [id] of revisions) {
        const e = this.entries.get(id);
        e.dirty = true;
        e.failures++;
        e.due =
          this.now() + Math.min(30000, 500 * 2 ** Math.min(e.failures - 1, 6));
      }
      this.onError(error);
    } finally {
      this.busy = false;
    }
  }
  status() {
    return {
      ...this.stats,
      groupIntervalMs: this.groupIntervalMs,
      writeIntervalMs: this.interval,
      pending: [...this.entries].filter(
        ([id, e]) => !this.excluded.has(id) && e.dirty
      ).length
    };
  }
}
