import { lookup as dnsLookup } from "node:dns";
import { promisify } from "node:util";
import net from "node:net";

const lookup = promisify(dnsLookup);

const BLOCKED_SUFFIXES = [".internal", ".local", ".localhost", ".lan"];

function isPrivateIPv4(ip: string): boolean {
  const m = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const [a, b] = [parseInt(m[1], 10), parseInt(m[2], 10)];
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 192 && b === 0 && (parseInt(m[3], 10) === 0 || parseInt(m[3], 10) === 2)) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a >= 224) return true;
  return false;
}

function isPrivateIPv6(ip: string): boolean {
  const v = ip.toLowerCase();
  if (v === "::1" || v === "::") return true;
  if (v.startsWith("fc") || v.startsWith("fd")) return true;
  if (v.startsWith("fe80")) return true;
  if (v.startsWith("ff")) return true;
  if (v.startsWith("::ffff:")) {
    const v4 = v.slice(7);
    return isPrivateIPv4(v4);
  }
  return false;
}

export class SsrfBlockedError extends Error {
  constructor(reason: string) {
    super(`blocked by SSRF guard: ${reason}`);
    this.name = "SsrfBlockedError";
  }
}

export async function assertPublicUrl(raw: string): Promise<void> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new SsrfBlockedError("invalid URL");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new SsrfBlockedError(`disallowed protocol: ${u.protocol}`);
  }
  const host = u.hostname.toLowerCase();
  if (!host) throw new SsrfBlockedError("empty hostname");
  for (const suf of BLOCKED_SUFFIXES) {
    if (host === suf.slice(1) || host.endsWith(suf)) {
      throw new SsrfBlockedError(`disallowed hostname suffix: ${host}`);
    }
  }

  if (net.isIP(host)) {
    if (net.isIPv4(host) && isPrivateIPv4(host)) {
      throw new SsrfBlockedError(`private IPv4: ${host}`);
    }
    if (net.isIPv6(host) && isPrivateIPv6(host)) {
      throw new SsrfBlockedError(`private IPv6: ${host}`);
    }
    return;
  }

  let resolved;
  try {
    resolved = await lookup(host, { all: true });
  } catch {
    throw new SsrfBlockedError(`DNS lookup failed: ${host}`);
  }
  for (const r of resolved) {
    if (r.family === 4 && isPrivateIPv4(r.address)) {
      throw new SsrfBlockedError(`resolves to private IPv4 ${r.address} (${host})`);
    }
    if (r.family === 6 && isPrivateIPv6(r.address)) {
      throw new SsrfBlockedError(`resolves to private IPv6 ${r.address} (${host})`);
    }
  }
}

export function isSsrfBlocked(e: unknown): e is SsrfBlockedError {
  return e instanceof SsrfBlockedError;
}
