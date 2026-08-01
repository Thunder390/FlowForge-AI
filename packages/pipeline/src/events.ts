/**
 * Generation events: what the UI shows while a workflow is being built.
 *
 * The design system asks for sequential text updates during generation. The
 * temptation is to fake these on a timer. Do not: a progress indicator that
 * advances while nothing is happening is a lie the user eventually notices, and
 * it gives no signal when a call has actually stalled. Every event here is
 * emitted from a real position in the state machine, and there is no clock
 * anywhere in this file.
 *
 * ## Node labels appear as the model writes them
 *
 * Pass A's stream is scanned for labels as it arrives, so `Planning "Announce
 * in Slack"...` shows up while the model is still writing the rest of the
 * document. That turns fifteen seconds of dead time into visible progress, and
 * it is the difference between a wait that feels responsive and one that feels
 * broken.
 *
 * The scan is a regex over accumulated text rather than an incremental JSON
 * parser. That is enough for a label and honest about what it is: the value it
 * produces is a progress string, the authoritative plan comes from parsing the
 * finished document against the schema, and a missed or malformed label costs
 * one progress line rather than correctness.
 */

import type { Stage } from "./stages.js";

export interface GenerationEvent {
  /** Monotonic from zero. A client replaying a stream orders by this. */
  sequence: number;
  stage: Stage;
  /** Written for the user, from the loading-state table in AI_SPEC.md. */
  text: string;
  /** Machine-readable specifics: counts, ids, capability lists. */
  detail?: Record<string, unknown>;
}

export type EventSink = (event: GenerationEvent) => void;

/** The text each stage announces itself with. */
export const STAGE_TEXT: Record<Stage, string> = {
  classify: "Understanding your request...",
  plan: "Designing the workflow...",
  retrieve: "Loading integration schemas...",
  parameters: "Configuring the steps...",
  merge: "Assembling the workflow...",
  validate: "Validating...",
  compile: "Checking it exports...",
};

/**
 * Collects events and hands them to an optional sink as they happen.
 *
 * Both, rather than one or the other: the sink is how a live client sees
 * progress, and the collected list is what gets persisted with the generation
 * and what a test asserts on.
 */
export class EventLog {
  readonly events: GenerationEvent[] = [];
  readonly #sink: EventSink | undefined;

  constructor(sink?: EventSink) {
    this.#sink = sink;
  }

  emit(stage: Stage, text: string, detail?: Record<string, unknown>): void {
    const event: GenerationEvent = {
      sequence: this.events.length,
      stage,
      text,
      ...(detail === undefined ? {} : { detail }),
    };
    this.events.push(event);
    this.#sink?.(event);
  }

  /** Announces a stage with its standard text. */
  enter(stage: Stage, detail?: Record<string, unknown>): void {
    this.emit(stage, STAGE_TEXT[stage], detail);
  }

  /** The stages that produced at least one event, in order, without repeats. */
  stagesSeen(): Stage[] {
    const seen: Stage[] = [];
    for (const event of this.events) {
      if (seen[seen.length - 1] !== event.stage) seen.push(event.stage);
    }
    return seen;
  }
}

/**
 * A node's `label`, and only a node's.
 *
 * `kind` is what distinguishes a node from the other things in a plan that
 * carry a label: a variable has `label` too, and reporting `Planning "Temporary
 * password"...` as though it were a step is worse than reporting nothing. The
 * pattern anchors on `kind` and requires `label` to follow it with no brace
 * between the two, which is a cheap way of saying "in the same object" without
 * writing a parser.
 *
 * If the model ever emits keys out of schema order the pattern simply misses,
 * and the cost is one progress line. The authoritative plan comes from parsing
 * the finished document against the schema, never from here.
 */
const NODE_LABEL = /"kind"\s*:\s*"[^"]*"[^{}]*?"label"\s*:\s*"((?:[^"\\]|\\.)*)"/g;

/**
 * Emits one event per node label as pass A writes it.
 *
 * Stateful across calls because the stream arrives in chunks and a label can be
 * split across two of them: text accumulates, and only labels not yet reported
 * produce an event. Chunk boundaries therefore change nothing about the events
 * emitted, which is what makes the output the same whether a provider streams
 * in 96-character pieces or hands over the whole document at once.
 */
export class LabelWatcher {
  #buffer = "";
  /** Where the next scan starts. Keeps the whole stream linear rather than quadratic. */
  #scanned = 0;
  readonly #labels: string[] = [];

  /** Returns the labels this chunk completed, in the order they appeared. */
  push(chunk: string): string[] {
    this.#buffer += chunk;

    const found: string[] = [];
    const pattern = new RegExp(NODE_LABEL.source, "g");
    pattern.lastIndex = this.#scanned;

    let match: RegExpExecArray | null;
    while ((match = pattern.exec(this.#buffer)) !== null) {
      const raw = match[1];
      if (raw === undefined) continue;
      const label = unescapeJsonString(raw);
      this.#labels.push(label);
      found.push(label);
      // Everything up to the end of this match is settled, so the next chunk
      // never rescans it. A label straddling the boundary still lies after
      // this point and is found on the following pass.
      this.#scanned = match.index + match[0].length;
    }

    return found;
  }

  /** Labels seen so far, in the order the model wrote them. */
  get labels(): readonly string[] {
    return this.#labels;
  }

  get count(): number {
    return this.#labels.length;
  }
}

/**
 * The escapes a JSON string can carry, undone.
 *
 * `JSON.parse` on the quoted form would be shorter and would throw on a partial
 * escape at a chunk boundary, which is a normal thing to see here. A progress
 * line is not worth an exception.
 */
function unescapeJsonString(raw: string): string {
  return raw.replace(/\\(u[0-9a-fA-F]{4}|.)/g, (_match, escape: string) => {
    switch (escape[0]) {
      case "n":
        return "\n";
      case "t":
        return "\t";
      case "r":
        return "\r";
      case "b":
        return "\b";
      case "f":
        return "\f";
      case "u":
        return String.fromCharCode(Number.parseInt(escape.slice(1), 16));
      default:
        return escape;
    }
  });
}
