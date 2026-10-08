import { describe, expect, it } from "vitest";
import { allocate, formatCedis, percentOf } from "./money";
import { priceBooking, type FeeRule } from "./pricing";

const studentTenPercent = { kind: "percent" as const, basisPoints: 1000, concessionTypeId: "student" };
const bookingFee: FeeRule = { feeRuleId: "f1", name: "Booking fee", category: "booking_fee", calculation: "fixed", amountPesewas: 200 };
const levy: FeeRule = { feeRuleId: "f2", name: "Levy", category: "tax", calculation: "percent", basisPoints: 125 };

describe("money", () => {
  it("rounds percentages half up", () => {
    expect(percentOf(8_005, 1000)).toBe(801); // 800.5 → 801
    expect(percentOf(8_004, 1000)).toBe(800); // 800.4 → 800
  });

  it("allocates so parts always sum to the total", () => {
    expect(allocate(100, [1, 1, 1])).toEqual([34, 33, 33]);
    expect(allocate(0, [5, 5])).toEqual([0, 0]);
    expect(allocate(7, [0, 0])).toEqual([4, 3]);
    const parts = allocate(9_999, [3_333, 4_444, 2_222]);
    expect(parts.reduce((a, b) => a + b, 0)).toBe(9_999);
  });

  it("formats cedis", () => {
    expect(formatCedis(12_345)).toBe("GH₵ 123.45");
    expect(formatCedis(5)).toBe("GH₵ 0.05");
  });
});

describe("priceBooking (spec 13.4a)", () => {
  it("prices a plain seat at its base fare", () => {
    const priced = priceBooking([{ baseFarePesewas: 8_000 }]);
    expect(priced).toMatchObject({ subtotalPesewas: 8_000, feesPesewas: 0, totalPesewas: 8_000 });
    expect(priced.seats[0]).toMatchObject({ concessionPesewas: 0, farePesewas: 8_000, feesPesewas: 0, totalPesewas: 8_000 });
  });

  it("applies a student concession before fees", () => {
    const priced = priceBooking([{ baseFarePesewas: 8_000, concession: studentTenPercent }], [levy]);
    // 8000 − 800 = 7200; levy 1.25% of 7200 = 90.
    expect(priced.seats[0].concessionPesewas).toBe(800);
    expect(priced.subtotalPesewas).toBe(7_200);
    expect(priced.feesPesewas).toBe(90);
    expect(priced.totalPesewas).toBe(7_290);
  });

  it("charges a fixed booking fee once per booking, shared across seats", () => {
    const priced = priceBooking([{ baseFarePesewas: 8_000 }, { baseFarePesewas: 8_000 }, { baseFarePesewas: 8_000 }], [bookingFee]);
    expect(priced.feesPesewas).toBe(200);
    expect(priced.totalPesewas).toBe(24_200);
    expect(priced.seats.map((s) => s.feesPesewas)).toEqual([67, 67, 66]);
  });

  it("rounds once on the total, not per fee", () => {
    // Two 0.5% fees on 101 pesewas: each is 0.505; separately rounded would give 2, exactly it is 1.01 → 1.
    const half: FeeRule = { feeRuleId: "a", name: "A", category: "tax", calculation: "percent", basisPoints: 50 };
    const priced = priceBooking([{ baseFarePesewas: 101 }], [half, { ...half, feeRuleId: "b", name: "B" }]);
    expect(priced.feesPesewas).toBe(1);
    expect(priced.totalPesewas).toBe(102);
    expect(priced.fees.reduce((sum, fee) => sum + fee.amountPesewas, 0)).toBe(1);
  });

  it("keeps every component consistent for mixed seats", () => {
    const priced = priceBooking(
      [
        { baseFarePesewas: 9_999, concession: studentTenPercent },
        { baseFarePesewas: 12_500 },
        { baseFarePesewas: 7_333, concession: { kind: "fixed", pesewas: 500, concessionTypeId: "x" } },
      ],
      [bookingFee, levy],
    );
    expect(priced.seats.reduce((sum, s) => sum + s.totalPesewas, 0)).toBe(priced.totalPesewas);
    expect(priced.subtotalPesewas + priced.feesPesewas).toBe(priced.totalPesewas);
    for (const seat of priced.seats) {
      expect(seat.baseFarePesewas - seat.concessionPesewas + seat.feesPesewas).toBe(seat.totalPesewas);
    }
  });

  it("never makes a fare negative with a fixed concession", () => {
    const priced = priceBooking([{ baseFarePesewas: 300, concession: { kind: "fixed", pesewas: 500, concessionTypeId: "x" } }]);
    expect(priced.seats[0].farePesewas).toBe(0);
    expect(priced.totalPesewas).toBe(0);
  });

  it("refuses fractional or negative amounts", () => {
    expect(() => priceBooking([{ baseFarePesewas: 10.5 }])).toThrow(RangeError);
    expect(() => priceBooking([{ baseFarePesewas: -1 }])).toThrow(RangeError);
    expect(() => priceBooking([])).toThrow(RangeError);
  });
});
