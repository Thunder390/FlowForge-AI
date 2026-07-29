import { describe, expect, it } from "vitest";

import { findSecret, isSecretFieldName, SECRET_PATTERNS, shannonEntropy } from "./secrets.js";

describe("the pattern table", () => {
  it.each([
    ["openai_key", "sk-abcdefghijklmnopqrstuvwxyz0123456789"],
    ["slack_token", "xoxb-123456789012-abcdefghijkl"],
    ["github_token", `ghp_${"a".repeat(36)}`],
    ["aws_access_key_id", "AKIAIOSFODNN7EXAMPLE"],
    ["google_api_key", `AIza${"B".repeat(35)}`],
    ["private_key", "-----BEGIN RSA PRIVATE KEY-----"],
    ["jwt", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature"],
  ])("recognises %s", (name, value) => {
    expect(findSecret(value)?.pattern).toBe(name);
  });

  it("finds a secret embedded in surrounding text", () => {
    expect(findSecret("Authorization: Bearer AKIAIOSFODNN7EXAMPLE now")?.pattern).toBe(
      "aws_access_key_id",
    );
  });

  it("carries no global flag, so a pattern matches every time it is asked", () => {
    // A global regex keeps lastIndex between calls, and a scanner that matches
    // only every other time is worse than none.
    for (const candidate of SECRET_PATTERNS) {
      expect(candidate.pattern.global).toBe(false);
    }
  });

  it("names every pattern uniquely", () => {
    const names = SECRET_PATTERNS.map((p) => p.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe("masking", () => {
  it("never echoes the matched value back", () => {
    const secret = "AKIAIOSFODNN7EXAMPLE";
    const match = findSecret(secret);
    // Validation errors reach logs and the repair prompt. Proving we found a
    // secret by reprinting it would spread it to three more places.
    expect(match?.preview).not.toContain(secret);
    expect(match?.preview).toBe("AKIA... (20 characters)");
  });
});

describe("the generic high-entropy fallback", () => {
  const opaque = "Xk93jFmQ2pLzR7vBn4TcYw8sHdG1aUeI0oPq5MrN";

  it("needs both a secret-like field name and a high-entropy run", () => {
    expect(findSecret(opaque, { fieldNames: ["api_key"] })?.pattern).toBe(
      "high_entropy_string",
    );
    expect(findSecret(opaque, { fieldNames: ["channel"] })).toBeUndefined();
    expect(findSecret("hello", { fieldNames: ["api_key"] })).toBeUndefined();
  });

  it("ignores a long run below the length threshold", () => {
    expect(findSecret(opaque.slice(0, 39), { fieldNames: ["token"] })).toBeUndefined();
  });

  it("ignores long low-entropy text in a secret-like field", () => {
    expect(
      findSecret("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", { fieldNames: ["token"] }),
    ).toBeUndefined();
  });

  it("ignores an expression, which is the shape authors are told to use", () => {
    // {{ $vars.temp_password }} in a parameter named password is correct, and a
    // scanner that rejects it would push people back toward the wrong pattern.
    expect(
      findSecret("{{ $vars.temp_password }}", { fieldNames: ["password"] }),
    ).toBeUndefined();
  });

  it("still catches a literal sitting next to an expression", () => {
    expect(
      findSecret(`{{ $vars.user }}:${opaque}`, { fieldNames: ["credentials"] })?.pattern,
    ).toBe("high_entropy_string");
  });

  it("checks every key on the path, not only the innermost", () => {
    expect(findSecret(opaque, { fieldNames: ["auth", "value"] })?.pattern).toBe(
      "high_entropy_string",
    );
  });
});

describe("isSecretFieldName", () => {
  it.each(["api_key", "apiKey", "PASSWORD", "client_secret", "authToken", "credentials"])(
    "flags %s",
    (name) => {
      expect(isSecretFieldName(name)).toBe(true);
    },
  );

  it.each(["channel", "text", "email", "primary_email", "items", "max_iterations"])(
    "leaves %s alone",
    (name) => {
      expect(isSecretFieldName(name)).toBe(false);
    },
  );
});

describe("shannonEntropy", () => {
  it("is zero for a single repeated character", () => {
    expect(shannonEntropy("aaaaaaaa")).toBe(0);
  });

  it("is zero for the empty string", () => {
    expect(shannonEntropy("")).toBe(0);
  });

  it("is one bit for two equally frequent characters", () => {
    expect(shannonEntropy("abab")).toBe(1);
  });

  it("ranks an opaque token above prose of the same length", () => {
    const token = "Xk93jFmQ2pLzR7vBn4TcYw8sHdG1aUeI0oPq5MrN";
    const prose = "the quick brown fox jumps over the lazy d";
    expect(shannonEntropy(token)).toBeGreaterThan(shannonEntropy(prose));
  });
});
