import { allocate, assertPesewas, divideHalfUp, percentOf } from "./money";

/**
 * How a price is built (spec 13.4a). The order is fixed so checkout and
 * finance always agree:
 *   1. Base fare per seat, from the fare rule for the stop pair and seat type.
 *   2. Concession per seat, if the passenger has a valid verification (D25).
 *   3. Promotion: release 2, not applied yet.
 *   4. Sum of the seat amounts.
 *   5. Fees: fixed per booking, or a percentage of the discounted sum.
 *   6. Rounding once, to the pesewa, half up, on the booking total; each
 *      seat's share is allocated so the shares sum exactly to the total.
 *
 * A concession is a per-seat component, so its discount is a whole pesewa
 * per seat (half up). Fees are summed exactly and rounded once with the
 * total. Every component is returned so it can be stored as sold.
 */

export type Concession =
  | { kind: "percent"; basisPoints: number; concessionTypeId: string }
  | { kind: "fixed"; pesewas: number; concessionTypeId: string };

export type FeeRule = {
  feeRuleId: string;
  name: string;
  category: "booking_fee" | "tax" | "provider_fee";
} & ({ calculation: "fixed"; amountPesewas: number } | { calculation: "percent"; basisPoints: number });

export type SeatPriceInput = {
  baseFarePesewas: number;
  concession?: Concession;
};

export type PricedSeat = {
  baseFarePesewas: number;
  concessionPesewas: number;
  concessionTypeId: string | null;
  /** base − concession */
  farePesewas: number;
  /** This seat's share of the booking's fees. */
  feesPesewas: number;
  /** fare + fees share. The seats' totals sum to the booking total. */
  totalPesewas: number;
};

export type PricedFee = { feeRuleId: string; name: string; category: FeeRule["category"]; amountPesewas: number };

export type PricedBooking = {
  seats: PricedSeat[];
  /** Sum of seat fares after concessions. */
  subtotalPesewas: number;
  fees: PricedFee[];
  feesPesewas: number;
  totalPesewas: number;
};

const FEE_SCALE = 10_000n; // basis points

export function priceBooking(seats: SeatPriceInput[], feeRules: FeeRule[] = []): PricedBooking {
  if (seats.length === 0) throw new RangeError("A booking needs at least one seat");

  // Steps 1–2: per-seat fare after concession.
  const pricedFares = seats.map((seat) => {
    assertPesewas(seat.baseFarePesewas);
    const concessionPesewas = concessionAmount(seat.baseFarePesewas, seat.concession);
    return {
      baseFarePesewas: seat.baseFarePesewas,
      concessionPesewas,
      concessionTypeId: seat.concession?.concessionTypeId ?? null,
      farePesewas: seat.baseFarePesewas - concessionPesewas,
    };
  });

  // Step 4: sum.
  const subtotal = pricedFares.reduce((sum, seat) => sum + seat.farePesewas, 0);

  // Step 5: fees, kept exact (scaled by 10 000) until the single rounding.
  const exactFees = feeRules.map((rule) => ({
    rule,
    scaled:
      rule.calculation === "fixed"
        ? BigInt(rule.amountPesewas) * FEE_SCALE
        : BigInt(subtotal) * BigInt(rule.basisPoints),
  }));
  const exactFeesTotal = exactFees.reduce((sum, fee) => sum + fee.scaled, 0n);

  // Step 6: round once, on the total.
  const total = Number(divideHalfUp(BigInt(subtotal) * FEE_SCALE + exactFeesTotal, FEE_SCALE));
  const feesTotal = total - subtotal;

  // Split the rounded fee total across the fee lines (for display) and across seats.
  const feeLineAmounts = allocate(feesTotal, exactFees.map((fee) => Number(fee.scaled)));
  const fees: PricedFee[] = exactFees.map((fee, i) => ({
    feeRuleId: fee.rule.feeRuleId,
    name: fee.rule.name,
    category: fee.rule.category,
    amountPesewas: feeLineAmounts[i],
  }));
  const seatFeeShares = allocate(feesTotal, pricedFares.map((seat) => seat.farePesewas));

  const pricedSeats = pricedFares.map((seat, i) => ({
    ...seat,
    feesPesewas: seatFeeShares[i],
    totalPesewas: seat.farePesewas + seatFeeShares[i],
  }));

  return { seats: pricedSeats, subtotalPesewas: subtotal, fees, feesPesewas: feesTotal, totalPesewas: total };
}

function concessionAmount(base: number, concession: Concession | undefined): number {
  if (!concession) return 0;
  if (concession.kind === "percent") {
    if (!Number.isInteger(concession.basisPoints) || concession.basisPoints < 1 || concession.basisPoints > 10_000) {
      throw new RangeError("A percent concession is between 1 and 10 000 basis points");
    }
    return percentOf(base, concession.basisPoints);
  }
  assertPesewas(concession.pesewas);
  // A fixed discount never makes a fare negative.
  return Math.min(concession.pesewas, base);
}
