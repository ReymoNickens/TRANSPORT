/**
 * Money is whole pesewas in a JavaScript number (safe to 9 quadrillion).
 * Never floating point arithmetic on amounts: percentages use basis points
 * (1 basis point = 0.01%) and integer division with explicit rounding.
 */

/** a × basisPoints / 10 000, rounded half up to the pesewa. */
export function percentOf(amountPesewas: number, basisPoints: number): number {
  assertPesewas(amountPesewas);
  const numerator = BigInt(amountPesewas) * BigInt(basisPoints);
  return Number(divideHalfUp(numerator, 10_000n));
}

/** Integer division rounding half up (amounts here are never negative). */
export function divideHalfUp(numerator: bigint, denominator: bigint): bigint {
  if (numerator < 0n || denominator <= 0n) throw new RangeError("divideHalfUp expects a non-negative numerator");
  return (numerator * 2n + denominator) / (denominator * 2n);
}

export function assertPesewas(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`Not a whole, non-negative pesewa amount: ${value}`);
  }
}

/**
 * Splits a total across parts in proportion to their weights so the parts
 * sum exactly to the total (largest remainder). Equal split when all weights are 0.
 */
export function allocate(total: number, weights: number[]): number[] {
  assertPesewas(total);
  if (weights.length === 0) return [];
  const sum = weights.reduce((a, b) => a + b, 0);
  const effective = sum === 0 ? weights.map(() => 1) : weights;
  const effectiveSum = BigInt(sum === 0 ? weights.length : sum);

  const shares = effective.map((w, index) => {
    const exact = BigInt(total) * BigInt(w);
    return { index, floor: exact / effectiveSum, remainder: exact % effectiveSum };
  });
  let leftover = BigInt(total) - shares.reduce((a, s) => a + s.floor, 0n);
  // Ties go to the earlier part, so the result is deterministic.
  const byRemainder = [...shares].sort((a, b) => (b.remainder === a.remainder ? a.index - b.index : b.remainder > a.remainder ? 1 : -1));
  for (const share of byRemainder) {
    if (leftover === 0n) break;
    share.floor += 1n;
    leftover -= 1n;
  }
  return shares.map((s) => Number(s.floor));
}

/** 12345 → "GH₵ 123.45" */
export function formatCedis(pesewas: number): string {
  assertPesewas(pesewas);
  const cedis = Math.floor(pesewas / 100);
  const rest = String(pesewas % 100).padStart(2, "0");
  return `GH₵ ${cedis.toLocaleString("en-GH")}.${rest}`;
}
