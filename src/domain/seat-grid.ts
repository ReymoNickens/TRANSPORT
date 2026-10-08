/**
 * Builds a seat map from a familiar description such as "2+2, 13 rows",
 * so a manager does not place every seat by hand (spec 8.3 guided workflows).
 * The result is a draft: individual seats can then be changed before publishing.
 */

export type SeatSpec = {
  seatNumber: string;
  rowNumber: number;
  columnNumber: number;
  seatType: "standard" | "premium" | "accessible";
  position: "window" | "aisle" | "middle" | null;
  bookable: boolean;
};

export type GridPattern = {
  /** Seats left of the aisle, for example 2. */
  left: number;
  /** Seats right of the aisle, for example 2. */
  right: number;
  rows: number;
  /** A full-width back row that also fills the aisle, common on coaches. */
  fullBackRow?: boolean;
};

export type SeatGrid = { rowCount: number; columnCount: number; seats: SeatSpec[] };

const LETTERS = "ABCDEFGH";

export function generateSeatGrid(pattern: GridPattern): SeatGrid {
  const { left, right, rows, fullBackRow = false } = pattern;
  if (!Number.isInteger(left) || !Number.isInteger(right) || left < 1 || right < 0 || left + right > 7) {
    throw new RangeError("Use between 1 and 7 seats per row across both sides of the aisle");
  }
  if (!Number.isInteger(rows) || rows < 1 || rows > 30) throw new RangeError("Use between 1 and 30 rows");

  const hasAisle = right > 0;
  const columnCount = left + right + (hasAisle ? 1 : 0);
  const aisleColumn = hasAisle ? left + 1 : null;
  const seats: SeatSpec[] = [];

  for (let row = 1; row <= rows; row++) {
    const isBackRow = row === rows && fullBackRow && hasAisle;
    let letter = 0;
    for (let column = 1; column <= columnCount; column++) {
      if (column === aisleColumn && !isBackRow) continue;
      seats.push({
        seatNumber: `${row}${LETTERS[letter++]}`,
        rowNumber: row,
        columnNumber: column,
        seatType: "standard",
        position: positionOf(column, columnCount, aisleColumn, isBackRow),
        bookable: true,
      });
    }
  }
  return { rowCount: rows, columnCount, seats };
}

function positionOf(column: number, columnCount: number, aisleColumn: number | null, isBackRow: boolean): SeatSpec["position"] {
  if (column === 1 || column === columnCount) return "window";
  if (aisleColumn !== null && !isBackRow && (column === aisleColumn - 1 || column === aisleColumn + 1)) return "aisle";
  return "middle";
}
