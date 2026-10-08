import { describe, expect, it } from "vitest";
import { formatCedis, parseCedis } from "./money";

describe("parseCedis", () => {
  it("reads amounts as people type them, in whole pesewas", () => {
    expect(parseCedis("25")).toBe(2500);
    expect(parseCedis("25.5")).toBe(2550);
    expect(parseCedis("25.05")).toBe(2505);
    expect(parseCedis(" GH₵ 1,200.50 ")).toBe(120050);
    expect(parseCedis("0.10")).toBe(10);
  });

  it("refuses what is not an amount", () => {
    for (const bad of ["", "abc", "1.234", "-5", "1e3", "12.", ".5"]) expect(parseCedis(bad)).toBeNull();
  });

  it("round-trips with formatCedis", () => {
    expect(parseCedis(formatCedis(98765))).toBe(98765);
  });
});
