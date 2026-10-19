/**
 * Who a request is and whether it gets in. There is no user database: a request is trusted
 * for where it comes from (this PC, with no proxy in front), for who Tailscale says it is
 * (the PC's own login, which `tailscale serve` states in a header it strips from what it
 * receives), or for what it holds (a paired device's cookie, or the shared token). A token,
 * when one is configured, is required of everything but a paired device, this PC and its own
 * Tailscale login included: a plain local connection, since the remote-PC bridge runs on a
 * loopback port of a PC other people may use, and the login, since any other proxy on this PC
 * (nginx, Caddy, a tunnel) passes a visitor's copy of that header on unless told to drop it.
 * Without a token, the login counts only with the one tailnet X-Forwarded-For address that
 * tailscale serve sends. A proxy that sets or appends X-Forwarded-For (nginx's usual
 * `$proxy_add_x_forwarded_for`, Caddy) sends another address or a chain; one that passes the
 * visitor's headers on untouched and adds none passes the visitor's forged address too.
 * Without a token, and until the first device is paired, anything that reaches the server is
 * let in as it always was, except through a proxy
 * on a PC whose Tailscale login is known: there, a request with no login header is a tagged
 * node (tailscale serve states no person for it), and a tailnet can hold many of those.
 * A PC whose own node is tagged has no login to compare with: its proxied requests pair, the
 * owner's included, unless HERDR_FLEET_TAILSCALE_OWNER names the login to let in.
 *
 * A proxy on this PC connects from loopback like a local client does, so it is known only by
 * what it sends: a forwarding header, or a Host that is not a name for this machine. A proxy
 * that sends neither (nginx's bare `proxy_pass` rewrites Host to the upstream address and adds
 * nothing) cannot be told from a local client: only a token closes that setup.
 */
import { BlockList, isIP } from "node:net";
import type { AccessRefusal, AccessVia, DeviceRole } from "../shared/protocol.ts";
import type { DeviceMatch } from "./devices.ts";

export interface AccessInput {
  /** the connection came from this machine: 127/8, ::1 or their IPv4-mapped forms */
  loopback: boolean;
  /** a proxy in front shows in the request (`cameThroughProxy`): tailscale serve and most reverse proxies do */
  forwarded: boolean;
  /** Tailscale-Funnel-Request: the request came from the public internet through Funnel */
  funnel: boolean;
  /** Tailscale-User-Login: set by tailscale serve for a person's device, absent for tagged nodes */
  tailscaleLogin: string | null;
  /** X-Forwarded-For: tailscale serve replaces it with the one address the request came from, never a chain */
  forwardedFor: string | null;
  /** the shared token matched (cookie or bearer) */
  tokenMatched: boolean;
  /** the device the cookie belongs to */
  device: DeviceMatch | null;
  /** the PC's own Tailscale login, when known */
  owner: string | null;
  /** this PC's Tailscale node is tagged: Tailscale runs here, and names no person as its owner */
  tagged: boolean;
  tokenConfigured: boolean;
  /** a device has been paired at some point: the gate is closed to strangers (server/devices.ts) */
  gated: boolean;
}

export type Access =
  | { level: "full"; via: AccessVia; role: DeviceRole; device?: DeviceMatch; login?: string }
  | { level: "none"; reason: AccessRefusal };

export function isLoopbackAddress(address: string): boolean {
  return address === "::1" || address.startsWith("127.") || address.startsWith("::ffff:127.");
}

/** Headers a proxy adds and a browser or CLI on this PC has no reason to send; a Tailscale login is stated by a proxy too. */
const PROXY_HEADERS = ["x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "x-real-ip", "forwarded", "via", "tailscale-user-login"];

/**
 * Is this Host header a name for this machine itself? It is read as a bare authority, a name
 * or a bracketed address with an optional port, and nothing else: handed to a URL parser,
 * `public.example@localhost` and `localhost/x@public.example` both came out as localhost.
 */
export function isLoopbackHost(host: string): boolean {
  const authority = /^(\[[0-9a-f:.]+\]|[a-z0-9.-]+)(?::\d{1,5})?$/i.exec(host);
  if (!authority) return false;
  // one trailing dot is the DNS root, the same name
  const name = authority[1]!.toLowerCase().replace(/\.$/, "");
  return name === "localhost" || name.endsWith(".localhost") || name === "[::1]"
    || /^127(?:\.\d{1,3}){3}$/.test(name) || /^\[::ffff:127(?:\.\d{1,3}){3}\]$/.test(name);
}

/**
 * Evidence that a request reached this server through a proxy. Claiming it only ever costs the
 * sender the trust a local connection has, so a forged header gains nothing.
 */
export function cameThroughProxy(headers: Headers): boolean {
  if (PROXY_HEADERS.some((name) => headers.has(name))) return true;
  // no Host at all is not how a browser or a CLI on this PC asks (HTTP/1.0 through a proxy is)
  const host = headers.get("host");
  return host === null || !isLoopbackHost(host);
}

// Tailscale v1.102.3: ipn/ipnlocal/serve.go:1068-1106 sets X-Forwarded-For to the source address
// (netip.Addr.String: no port, IPv6 unbracketed) and strips identity headers a visitor sent;
// net/tsaddr/tsaddr.go names the tailnet ranges. This stops a proxy on this PC that sets or
// appends X-Forwarded-For from passing a visitor's own login header through. One that forwards
// the visitor's headers untouched, or a raw tunnel, can still carry both: only a token closes that.
const tailnetIpv4 = new BlockList();
tailnetIpv4.addSubnet("100.64.0.0", 10, "ipv4");
const tailnetIpv6 = new BlockList();
tailnetIpv6.addSubnet("fd7a:115c:a1e0::", 48, "ipv6");

function fromTailnet(forwardedFor: string | null): boolean {
  const address = forwardedFor ?? "";
  const family = isIP(address);
  return family === 4 ? tailnetIpv4.check(address, "ipv4") : family === 6 && tailnetIpv6.check(address, "ipv6");
}

export function decideAccess(input: AccessInput): Access {
  if (input.tokenMatched) return { level: "full", via: "token", role: "drive" };
  if (input.device !== null) return { level: "full", via: "device", role: input.device.role, device: input.device };
  // before the login header: a token must hold against a header a visitor can send through another proxy
  if (input.tokenConfigured) return { level: "none", reason: "token_required" };
  // the identity header is only worth something from the local tailscaled, never from a LAN client
  if (input.loopback && input.tailscaleLogin !== null && input.owner !== null) {
    if (!fromTailnet(input.forwardedFor)) return { level: "none", reason: "pairing_required" };
    if (input.tailscaleLogin.toLowerCase() === input.owner.toLowerCase()) return { level: "full", via: "tailscale", role: "drive", login: input.tailscaleLogin };
    return { level: "none", reason: "other_user" };
  }
  if (input.loopback && !input.forwarded) return { level: "full", via: "local", role: "drive" };
  // Everything else needs a token or a paired device, paired or not yet. A loopback request
  // under a foreign Host (a DNS-rebound page, a proxy) is not "this PC".
  return { level: "none", reason: "pairing_required" };
}
