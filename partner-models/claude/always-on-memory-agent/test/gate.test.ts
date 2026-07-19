import assert from "node:assert/strict";
import { test } from "node:test";

// The agent module constructs an SDK client at import time — give it inert env
process.env.ANTHROPIC_API_KEY = "test-key";
process.env.MEMORY_DB = ":memory:";
const { OperationGate } = await import("../src/agent.js");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("shared operations run concurrently up to the cap", async () => {
  const gate = new OperationGate(2);
  let active = 0;
  let peak = 0;
  const task = () =>
    gate.runShared(async () => {
      active++;
      peak = Math.max(peak, active);
      await sleep(20);
      active--;
    });
  await Promise.all([task(), task(), task(), task(), task()]);
  assert.equal(peak, 2); // never above the cap, but genuinely parallel
});

test("exclusive waits for shared to drain and blocks new shared", async () => {
  const gate = new OperationGate(3);
  const order: string[] = [];

  const shared = (name: string, ms: number) =>
    gate.runShared(async () => {
      order.push(`${name}:start`);
      await sleep(ms);
      order.push(`${name}:end`);
    });
  const exclusive = () =>
    gate.runExclusive(async () => {
      order.push("excl:start");
      await sleep(10);
      order.push("excl:end");
    });

  const a = shared("a", 30);
  const b = shared("b", 30);
  await sleep(5); // let a and b start
  const e = exclusive();
  await sleep(5);
  const c = shared("c", 10); // arrives after the exclusive — FIFO holds it back
  await Promise.all([a, b, e, c]);

  // Exclusive starts only after a and b end; c starts only after exclusive ends
  assert.ok(order.indexOf("excl:start") > order.indexOf("a:end"));
  assert.ok(order.indexOf("excl:start") > order.indexOf("b:end"));
  assert.ok(order.indexOf("c:start") > order.indexOf("excl:end"));
});

test("errors release the gate", async () => {
  const gate = new OperationGate(1);
  await assert.rejects(gate.runShared(async () => {
    throw new Error("boom");
  }));
  // The gate must not be stuck
  const ok = await gate.runExclusive(async () => "recovered");
  assert.equal(ok, "recovered");
});
