import { describe, expect, it } from "vitest";
import { generateSeatGrid } from "./seat-grid";

describe("generateSeatGrid", () => {
  it("builds a 2+2 coach with an aisle", () => {
    const grid = generateSeatGrid({ left: 2, right: 2, rows: 13 });
    expect(grid).toMatchObject({ rowCount: 13, columnCount: 5 });
    expect(grid.seats).toHaveLength(52);
    expect(grid.seats.slice(0, 4).map((s) => [s.seatNumber, s.columnNumber, s.position])).toEqual([
      ["1A", 1, "window"],
      ["1B", 2, "aisle"],
      ["1C", 4, "aisle"],
      ["1D", 5, "window"],
    ]);
    expect(grid.seats.some((s) => s.columnNumber === 3)).toBe(false);
  });

  it("fills the aisle on a full back row", () => {
    const grid = generateSeatGrid({ left: 2, right: 2, rows: 12, fullBackRow: true });
    expect(grid.seats).toHaveLength(11 * 4 + 5);
    const back = grid.seats.filter((s) => s.rowNumber === 12);
    expect(back.map((s) => s.seatNumber)).toEqual(["12A", "12B", "12C", "12D", "12E"]);
    expect(back[2].position).toBe("middle");
  });

  it("gives every seat a unique number and position", () => {
    const grid = generateSeatGrid({ left: 3, right: 2, rows: 10, fullBackRow: true });
    expect(new Set(grid.seats.map((s) => s.seatNumber)).size).toBe(grid.seats.length);
    expect(new Set(grid.seats.map((s) => `${s.rowNumber}:${s.columnNumber}`)).size).toBe(grid.seats.length);
  });

  it("refuses impossible shapes", () => {
    expect(() => generateSeatGrid({ left: 0, right: 2, rows: 10 })).toThrow(RangeError);
    expect(() => generateSeatGrid({ left: 4, right: 4, rows: 10 })).toThrow(RangeError);
    expect(() => generateSeatGrid({ left: 2, right: 2, rows: 31 })).toThrow(RangeError);
  });
});
