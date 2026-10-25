import { describe, expect, it } from "vitest";
import { cleanName, isCode, normalizeCode, parseClientMessage } from "../../src/core/protocol.ts";

const TOKEN = "0123456789abcdef0123456789abcdef";

describe("parseClientMessage", () => {
  it("reads every kind of message", () => {
    expect(parseClientMessage(JSON.stringify({ t: "hello", v: 1, token: TOKEN, name: "Ana" }))).toEqual({
      t: "hello",
      v: 1,
      token: TOKEN,
      name: "Ana",
    });
    expect(parseClientMessage('{"t":"shot","shot":{"vx":10,"vy":-300},"at":3}')).toEqual({
      t: "shot",
      shot: { vx: 10, vy: -300 },
      at: 3,
    });
    expect(parseClientMessage('{"t":"aim","aim":{"angle":1.5,"power":0.4}}')).toEqual({
      t: "aim",
      aim: { angle: 1.5, power: 0.4 },
    });
    expect(parseClientMessage('{"t":"aim","aim":null}')).toEqual({ t: "aim", aim: null });
    for (const t of ["start", "ready", "rematch", "leave", "ping"]) {
      expect(parseClientMessage(JSON.stringify({ t, extra: 1 }))).toEqual({ t });
    }
  });

  it("drops anything malformed", () => {
    const bad = [
      "not json",
      "null",
      '{"t":"nope"}',
      '{"t":"hello","v":1,"token":"short"}',
      '{"t":"shot","shot":{"vx":1e9,"vy":0},"at":0}',
      '{"t":"shot","shot":{"vx":0,"vy":-300},"at":"0"}',
      '{"t":"aim","aim":{"angle":1,"power":3}}',
      JSON.stringify({ t: "hello", v: 1, token: TOKEN, name: "x".repeat(600) }),
      42,
    ];
    for (const raw of bad) expect(parseClientMessage(raw), String(raw)).toBeNull();
  });
});

describe("names and codes", () => {
  it("cleans names to something short and printable", () => {
    expect(cleanName("  Ana  ", "P1")).toBe("Ana");
    expect(cleanName("a\u0000b\nc", "P1")).toBe("ab c");
    expect(cleanName("abcdefghijklmnopq", "P1")).toBe("abcdefghijkl");
    expect(cleanName("", "P1")).toBe("P1");
    expect(cleanName(7, "P1")).toBe("P1");
  });

  it("normalizes typed room codes", () => {
    expect(normalizeCode("bcd-fg")).toBe("BCDFG");
    expect(normalizeCode(" k7q xb ")).toBe("K7QXB");
    expect(isCode("BCDFG")).toBe(true);
    expect(isCode("ABCDE")).toBe(false);
    expect(isCode("BCDF")).toBe(false);
  });
});
