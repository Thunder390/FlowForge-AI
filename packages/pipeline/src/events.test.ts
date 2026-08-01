/**
 * Progress that is real.
 *
 * The design system asks for sequential updates during generation and the
 * tempting way to produce them is a timer. A timer lies: it advances while
 * nothing is happening and gives no signal when a call has stalled. These tests
 * are mostly about the label watcher, because that is the piece that turns a
 * stream into progress and the piece with a way of being subtly wrong.
 */

import { describe, expect, it } from "vitest";

import { EventLog, LabelWatcher, STAGE_TEXT } from "./events.js";
import { STAGES } from "./stages.js";

/** The shape pass A actually emits, condensed. */
const PLAN_JSON = JSON.stringify({
  name: "Employee onboarding",
  nodes: [
    { id: "n_trigger", kind: "trigger", capability: "a.b.c", label: "New employee" },
    { id: "n_slack", kind: "action", capability: "d.e.f", label: "Announce in Slack" },
  ],
  edges: [{ id: "e_1", from: "n_trigger", to: "n_slack" }],
  variables: [{ id: "temp_password", label: "Temporary password", type: "string" }],
});

function feed(text: string, chunkSize: number): string[] {
  const watcher = new LabelWatcher();
  const seen: string[] = [];
  for (let at = 0; at < text.length; at += chunkSize) {
    seen.push(...watcher.push(text.slice(at, at + chunkSize)));
  }
  return seen;
}

describe("watching for node labels", () => {
  it("reports a node label as the model writes it", () => {
    expect(feed(PLAN_JSON, PLAN_JSON.length)).toEqual([
      "New employee",
      "Announce in Slack",
    ]);
  });

  it("does not report a variable's label as though it were a step", () => {
    // Variables carry a `label` too. "Planning 'Temporary password'..." is
    // nonsense in a progress line, and it is what a naive scan produces.
    expect(feed(PLAN_JSON, 1)).not.toContain("Temporary password");
  });

  it("produces the same labels whatever the chunk boundaries are", () => {
    // A label split across two chunks is the normal case, not the edge case:
    // the provider chunks on byte counts, not on token meaning.
    const whole = feed(PLAN_JSON, PLAN_JSON.length);
    for (const size of [1, 2, 3, 7, 13, 64, 500]) {
      expect(feed(PLAN_JSON, size), `chunk size ${size}`).toEqual(whole);
    }
  });

  it("reports each label once, however many times it is scanned", () => {
    const watcher = new LabelWatcher();
    watcher.push('{"kind":"action","label":"Only once"');
    expect(watcher.push(', "capability":"x"}')).toEqual([]);
    expect(watcher.count).toBe(1);
  });

  it("counts labels and keeps them in the order they were written", () => {
    const watcher = new LabelWatcher();
    watcher.push(PLAN_JSON);
    expect(watcher.labels).toEqual(["New employee", "Announce in Slack"]);
    expect(watcher.count).toBe(2);
  });

  it("unescapes what it reports, so a quoted label reads correctly", () => {
    const text = '{"kind":"action","label":"Say \\"hello\\" loudly"}';
    expect(feed(text, 4)).toEqual(['Say "hello" loudly']);
  });

  it("handles a unicode escape without producing the raw sequence", () => {
    const text = '{"kind":"action","label":"caf\\u00e9"}';
    expect(feed(text, 3)).toEqual(["café"]);
  });

  it("does not reach across an object boundary for a label", () => {
    // A node followed by something else with a label: the `kind` belongs to
    // the first object and must not anchor a match in the second.
    const text = '{"kind":"action","label":"Real"},{"id":"v","label":"Not a step"}';
    expect(feed(text, 5)).toEqual(["Real"]);
  });

  it("emits nothing for text that contains no node", () => {
    expect(feed('{"name":"x","edges":[]}', 4)).toEqual([]);
  });
});

describe("the event log", () => {
  it("numbers events so a reconnecting client can order what it replays", () => {
    const log = new EventLog();
    log.enter("plan");
    log.emit("plan", 'Planning "x"...');
    log.enter("merge");
    expect(log.events.map((event) => event.sequence)).toEqual([0, 1, 2]);
  });

  it("hands each event to the sink as it happens, and keeps it", () => {
    // Both, rather than one or the other: the sink is how a live client sees
    // progress and the list is what gets persisted with the generation.
    const seen: string[] = [];
    const log = new EventLog((event) => seen.push(event.text));
    log.enter("validate");
    expect(seen).toEqual(["Validating..."]);
    expect(log.events).toHaveLength(1);
  });

  it("carries machine-readable detail alongside the text", () => {
    const log = new EventLog();
    log.enter("retrieve", { capabilities: ["slack.message.send"] });
    expect(log.events[0]?.detail).toEqual({ capabilities: ["slack.message.send"] });
  });

  it("omits detail entirely when there is none", () => {
    const log = new EventLog();
    log.enter("plan");
    expect(log.events[0]).not.toHaveProperty("detail");
  });

  it("collapses repeated stages when reporting which ones were seen", () => {
    const log = new EventLog();
    log.enter("plan");
    log.emit("plan", "still planning");
    log.enter("merge");
    expect(log.stagesSeen()).toEqual(["plan", "merge"]);
  });
});

describe("stage text", () => {
  it("has a line for every stage, including the ones M9 adds", () => {
    // A stage that starts running with no text would surface as an empty
    // progress line rather than as a missing key.
    for (const stage of STAGES) {
      expect(STAGE_TEXT[stage], stage).toBeTruthy();
    }
  });
});
