// Response helpers + security headers.

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "object-src 'none'",
].join('; ');

export function securityHeaders(headers = new Headers()) {
  headers.set('Content-Security-Policy', CSP);
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('X-Frame-Options', 'DENY');
  headers.set('Referrer-Policy', 'no-referrer');
  headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  return headers;
}

export function withSecurity(response, { noStore = true } = {}) {
  const res = new Response(response.body, response);
  securityHeaders(res.headers);
  if (noStore) res.headers.set('Cache-Control', 'no-store');
  return res;
}

export function json(data, status = 200, extraHeaders = {}) {
  const headers = new Headers({ 'Content-Type': 'application/json; charset=utf-8', ...extraHeaders });
  return withSecurity(new Response(JSON.stringify(data), { status, headers }));
}

export function error(status, message, extra = {}) {
  return json({ error: message, ...extra }, status);
}

export function redirect(location, extraHeaders = {}) {
  return withSecurity(new Response(null, { status: 302, headers: { Location: location, ...extraHeaders } }));
}

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Read a JSON body with a hard size cap (Spec §32: request size limits).
export async function readJson(request, maxBytes) {
  const type = request.headers.get('Content-Type') || '';
  if (!type.toLowerCase().startsWith('application/json')) {
    throw new HttpError(415, 'Content-Type must be application/json');
  }
  const declared = parseInt(request.headers.get('Content-Length') || '0', 10);
  if (declared > maxBytes) throw new HttpError(413, 'Request body too large');
  const buf = await request.arrayBuffer();
  if (buf.byteLength > maxBytes) throw new HttpError(413, 'Request body too large');
  try {
    const data = JSON.parse(new TextDecoder().decode(buf) || '{}');
    if (data === null || typeof data !== 'object' || Array.isArray(data)) throw new Error();
    return data;
  } catch {
    throw new HttpError(400, 'Invalid JSON body');
  }
}

export function clientIp(request) {
  return request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For')?.split(',')[0].trim() || 'unknown';
}
