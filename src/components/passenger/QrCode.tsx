"use client";

import QRCode from "qrcode";
import { useEffect, useState } from "react";

/** The QR shows only the opaque token (14.2): no name, seat or amount. */
export function QrCode({ value, label }: { value: string; label: string }) {
  const [svg, setSvg] = useState<string | null>(null);
  useEffect(() => {
    QRCode.toString(value, { type: "svg", margin: 1, errorCorrectionLevel: "M" }).then(setSvg).catch(() => setSvg(null));
  }, [value]);
  if (!svg) return <div className="aspect-square w-56 animate-pulse rounded bg-border" aria-hidden />;
  return (
    <div
      role="img"
      aria-label={label}
      className="w-56 rounded-lg bg-white p-2"
      // The SVG is generated locally from our own token.
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
