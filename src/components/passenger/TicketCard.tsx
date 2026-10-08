import { formatDay, formatTime } from "@/lib/format";
import { QrCode } from "./QrCode";

export type TicketCardProps = {
  bookingReference: string;
  ticketNumber: string;
  state: string | null;
  passengerName: string;
  seatNumber: string;
  fareType: string;
  routeName: string;
  originName: string;
  destinationName: string;
  departsAt: string | Date;
  qrToken: string | null;
  boardingCode: string | null;
};

/** One ticket per seat (14.1, 7.8). */
export function TicketCard(t: TicketCardProps) {
  const valid = t.state === "VALID" && t.qrToken;
  return (
    <article className="flex flex-col gap-4 rounded-xl border border-border p-4">
      <header className="flex items-start justify-between gap-4">
        <div>
          <p className="text-sm text-muted">{formatDay(t.departsAt)} · {formatTime(t.departsAt)}</p>
          <h2 className="text-lg font-semibold">{t.originName} → {t.destinationName}</h2>
        </div>
        <p className="text-right text-sm">
          <span className="block text-muted">Seat</span>
          <span className="text-2xl font-semibold">{t.seatNumber}</span>
        </p>
      </header>
      <dl className="grid grid-cols-2 gap-2 text-sm">
        <div><dt className="text-muted">Passenger</dt><dd>{t.passengerName}</dd></div>
        <div><dt className="text-muted">Fare</dt><dd>{t.fareType}</dd></div>
        <div><dt className="text-muted">Booking</dt><dd className="font-mono">{t.bookingReference}</dd></div>
        <div><dt className="text-muted">Ticket</dt><dd className="font-mono">{t.ticketNumber}</dd></div>
      </dl>
      {valid ? (
        <div className="flex flex-col items-center gap-2">
          <QrCode value={t.qrToken!} label={`Boarding QR code for seat ${t.seatNumber}`} />
          <p className="text-sm text-muted">No signal or QR won&apos;t scan? Give the conductor this code:</p>
          <p className="font-mono text-2xl tracking-widest">{t.boardingCode}</p>
        </div>
      ) : (
        <p className="rounded-lg bg-border/50 p-3 text-sm">This ticket is {t.state?.toLowerCase() ?? "not issued yet"} and cannot be used to board.</p>
      )}
      {t.fareType !== "Standard" ? <p className="text-sm">Bring your student ID: the conductor will check it at boarding.</p> : null}
    </article>
  );
}
