/**
 * A target that knows nothing about any real platform.
 *
 * The compiler's shared half has no target to test against until M6b, and
 * waiting for one would mean stages 1 through 3 were first exercised by the
 * very thing they are supposed to be independent of. A fake closes that gap and
 * does something the real target cannot: its `TargetCapabilities` are settable
 * per test, so the pre-lowering check can be driven through every combination
 * without waiting for a platform that happens to have those limits.
 *
 * The fake is deliberately the dumbest thing that satisfies the interface. It
 * is not a reference implementation and nothing should copy it: `lower` records
 * names and edges, `emit` serializes them in a fixed key order, and `verify`
 * checks the two agree. What it proves is that the seam is real, that the
 * normalized graph carries enough to lower from, and that the driver runs the
 * stages in the specified order.
 */

import type { PlatformIR, Target, TargetCapabilities } from "../target.js";

/** A target that can do everything. n8n and Node-RED both look like this. */
export const FULL_CAPABILITIES: TargetCapabilities = {
  branching: "full",
  loops: true,
  errorRouting: true,
  retryPolicy: true,
  parallelBranches: true,
  expressionSyntax: "n8n",
};

/** Zapier's shape: the genuinely constrained one, and where the abstraction leaks if it does. */
export const LINEAR_CAPABILITIES: TargetCapabilities = {
  branching: "linear_only",
  loops: false,
  errorRouting: false,
  retryPolicy: false,
  parallelBranches: false,
  expressionSyntax: "zapier",
};

export interface FakeIR extends PlatformIR {
  nodes: { name: string; capability: string; degraded: boolean }[];
  connections: { from: string; to: string; port: string }[];
}

export interface FakeTargetOptions {
  key?: string;
  displayName?: string;
  fileExtension?: string;
  capabilities?: Partial<TargetCapabilities>;
  /** Forces stage 6 to fail, so the driver's internal-error path can be tested. */
  breakVerify?: boolean;
  /** Stamps the IR with the wrong target, which the driver must catch. */
  misstampIR?: boolean;
}

export function fakeTarget(options: FakeTargetOptions = {}): Target {
  const key = options.key ?? "fake";
  const capabilities: TargetCapabilities = {
    ...FULL_CAPABILITIES,
    ...options.capabilities,
  };

  return {
    key,
    displayName: options.displayName ?? "Fake Platform",
    fileExtension: options.fileExtension ?? "json",
    capabilities,

    lower(graph) {
      const ir: FakeIR = {
        target: options.misstampIR === true ? `not-${key}` : key,
        // Topological order, straight from the graph. A target that needed to
        // re-sort would mean stage 3 had not finished its job.
        nodes: graph.nodes.map((node) => ({
          name: node.displayName,
          capability: node.boundCapability,
          degraded: node.degraded,
        })),
        connections: graph.edges.map((edge) => ({
          from: graph.displayNames.get(edge.from) ?? edge.from,
          to: graph.displayNames.get(edge.to) ?? edge.to,
          port: edge.port,
        })),
      };
      return ir;
    },

    emit(ir) {
      const fake = ir as FakeIR;
      return {
        target: fake.target,
        // Fixed key order and no clock, no random id. Same input, same bytes.
        content: `${JSON.stringify(
          {
            target: fake.target,
            nodes: fake.nodes.map((node) => ({
              name: node.name,
              capability: node.capability,
              degraded: node.degraded,
            })),
            connections: fake.connections.map((connection) => ({
              from: connection.from,
              to: connection.to,
              port: connection.port,
            })),
          },
          null,
          2,
        )}\n`,
      };
    },

    verify(output) {
      if (options.breakVerify === true) {
        return { ok: false, failures: ["forced failure for testing"] };
      }

      const parsed = JSON.parse(output.content) as FakeIR;
      const names = new Set(parsed.nodes.map((node) => node.name));
      const failures: string[] = [];

      if (names.size !== parsed.nodes.length) failures.push("duplicate node names");
      for (const connection of parsed.connections) {
        if (!names.has(connection.from)) {
          failures.push(`connection from unknown node "${connection.from}"`);
        }
        if (!names.has(connection.to)) {
          failures.push(`connection to unknown node "${connection.to}"`);
        }
      }

      return failures.length === 0 ? { ok: true } : { ok: false, failures };
    },
  };
}
