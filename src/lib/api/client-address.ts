/** The caller's IP address, if it looks like one (it goes into an inet column). */
export function clientAddress(request: Request): string | null {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const candidate = forwarded || request.headers.get("x-real-ip") || null;
  return candidate && /^[0-9a-fA-F:.]{3,45}$/.test(candidate) ? candidate : null;
}
