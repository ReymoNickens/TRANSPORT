import { describe, expect, it } from "vitest";
import { maskPhone, normaliseGhanaPhone } from "./phone";

describe("normaliseGhanaPhone", () => {
  it.each([
    ["024 123 4567", "+233241234567"],
    ["0241234567", "+233241234567"],
    ["233241234567", "+233241234567"],
    ["+233 24 123 4567", "+233241234567"],
    ["(050) 123-4567", "+233501234567"],
    ["241234567", "+233241234567"],
  ])("accepts %s", (input, expected) => {
    expect(normaliseGhanaPhone(input)).toBe(expected);
  });

  it.each(["", "12345", "0341234567", "+44 7700 900123", "02412345678", "abc"])("refuses %s", (input) => {
    expect(normaliseGhanaPhone(input)).toBeNull();
  });
});

describe("maskPhone", () => {
  it("keeps only the last three digits", () => {
    expect(maskPhone("+233241234567")).toBe("**********567");
  });
});
