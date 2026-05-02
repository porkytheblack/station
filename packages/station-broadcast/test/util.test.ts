import { test } from "node:test";
import assert from "node:assert/strict";
import { topologicalSort } from "../src/util.js";
import { BroadcastCycleError } from "../src/errors.js";

test("orders roots before dependents", () => {
  const sorted = topologicalSort("b", [
    { name: "c", dependsOn: ["a", "b"] },
    { name: "b", dependsOn: ["a"] },
    { name: "a", dependsOn: [] },
  ]);
  assert.deepEqual(sorted.map((n) => n.name), ["a", "b", "c"]);
});

test("throws on cycles", () => {
  assert.throws(
    () => topologicalSort("b", [
      { name: "a", dependsOn: ["b"] },
      { name: "b", dependsOn: ["a"] },
    ]),
    BroadcastCycleError,
  );
});

test("does not throw a false cycle when two nodes share an unknown dep", () => {
  // Regression: visit() used to leak `visiting` on the unknown-dep early
  // return, causing the second visit to the same name to throw a false cycle.
  const sorted = topologicalSort("b", [
    { name: "a", dependsOn: ["ghost"] },
    { name: "b", dependsOn: ["ghost"] },
  ]);
  assert.equal(sorted.length, 2);
});

test("self-cycle is detected", () => {
  assert.throws(
    () => topologicalSort("b", [{ name: "a", dependsOn: ["a"] }]),
    BroadcastCycleError,
  );
});

test("disconnected components are all sorted", () => {
  const sorted = topologicalSort("b", [
    { name: "a", dependsOn: [] },
    { name: "b", dependsOn: ["a"] },
    { name: "c", dependsOn: [] },
    { name: "d", dependsOn: ["c"] },
  ]);
  assert.equal(sorted.length, 4);
  // a precedes b; c precedes d
  assert.ok(sorted.findIndex((n) => n.name === "a") < sorted.findIndex((n) => n.name === "b"));
  assert.ok(sorted.findIndex((n) => n.name === "c") < sorted.findIndex((n) => n.name === "d"));
});
