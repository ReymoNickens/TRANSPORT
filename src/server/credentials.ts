import { createHash, createHmac, randomUUID } from "node:crypto";
import type { Tx } from "@/lib/db";

/**
 * Ticket credentials (spec 14.2). Three secrets per credential, each derived
 * from the server secret and the credential id, so none is ever stored:
 *   - the QR token (256 bits, opaque),
 *   - the ticket-link token for text messages (a different token, so a leaked
 *     link does not reveal the QR),
 *   - a 6-character boarding code, checked together with the ticket number.
 * Only SHA-256 hashes are stored, for lookup. Rotating (a new credential row)
 * changes all three and revokes the old ones.
 */

const CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

function derive(secret: string, label: string, credentialId: string): Buffer {
  return createHmac("sha256", secret).update(`${label}:${credentialId}`).digest();
}

export function sha256(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

export type CredentialSecrets = { qrToken: string; linkToken: string; boardingCode: string };

export function credentialSecrets(secret: string, credentialId: string): CredentialSecrets {
  const codeBytes = derive(secret, "code", credentialId);
  let boardingCode = "";
  for (let i = 0; i < 6; i++) boardingCode += CODE_ALPHABET[codeBytes[i] % CODE_ALPHABET.length];
  return {
    qrToken: derive(secret, "qr", credentialId).toString("base64url"),
    linkToken: derive(secret, "link", credentialId).toString("base64url"),
    boardingCode,
  };
}

/** The stored hash of a boarding code is bound to its ticket number. */
export function boardingCodeHash(ticketNumber: string, code: string): Buffer {
  return sha256(`${ticketNumber}:${code.toUpperCase()}`);
}

/** Gives every ticket of a booking a current credential. Safe to repeat. */
export async function issueCredentials(tx: Tx, secret: string, bookingId: string): Promise<number> {
  const tickets = await tx<{ id: string; organisationId: string; ticketNumber: string }[]>`
    select t.id, t.organisation_id, t.ticket_number
    from app.tickets t join app.booked_seats s on s.id = t.booked_seat_id
    where s.booking_id = ${bookingId} and t.state = 'VALID'
      and not exists (select 1 from app.ticket_credentials c where c.ticket_id = t.id and c.revoked_at is null)
    order by t.id`;
  for (const ticket of tickets) {
    const id = randomUUID();
    const secrets = credentialSecrets(secret, id);
    await tx`
      insert into app.ticket_credentials (id, organisation_id, ticket_id, token_hash, link_token_hash, boarding_code_hash)
      values (${id}, ${ticket.organisationId}, ${ticket.id}, ${sha256(secrets.qrToken)}, ${sha256(secrets.linkToken)},
              ${boardingCodeHash(ticket.ticketNumber, secrets.boardingCode)})`;
  }
  return tickets.length;
}

/** The current credential id of each ticket, to show the QR and code to its owner. */
export async function currentCredentials(tx: Tx, ticketIds: string[]): Promise<Map<string, string>> {
  if (ticketIds.length === 0) return new Map();
  const rows = await tx<{ ticketId: string; id: string }[]>`
    select ticket_id, id from app.ticket_credentials where ticket_id = any(${ticketIds}::uuid[]) and revoked_at is null`;
  return new Map(rows.map((r) => [r.ticketId, r.id]));
}
