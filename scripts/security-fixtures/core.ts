/** The decisions core takes over (format.ts): access, the file viewer's answers and push endpoints. */
import { cameThroughProxy, decideAccess, isLoopbackAddress, isLoopbackHost, type AccessInput } from "../../server/access.ts";
import { isAuthenticated, requiresAuth } from "../../server/auth.ts";
import { fileResponse, parseViewPath } from "../../server/file-view.ts";
import { sameOrigin } from "../../server/http.ts";
import { isPushServiceEndpoint, parseSubscription } from "../../server/push.ts";
import type { FileInfo } from "../../shared/protocol.ts";
import { headerList, headersOf, type Decision } from "./format.ts";

/** a request to this server; only isAuthenticated's headers are read */
const AUTH_URL = "http://localhost:7317/api/health";

interface FileResponseInput {
  file: Pick<FileInfo, "name" | "mime" | "kind">;
  download: boolean;
  page?: { host: string | null; paneId: string | null };
}

export const coreDecisions: Record<string, Decision> = {
  decideAccess: (input: AccessInput) => decideAccess(input),
  isLoopbackAddress: (address: string) => isLoopbackAddress(address),
  isLoopbackHost: (host: string) => isLoopbackHost(host),
  cameThroughProxy: (headers: unknown) => cameThroughProxy(headersOf(headers)),
  isAuthenticated: ({ headers, token }: { headers: unknown; token: string }) => isAuthenticated(new Request(AUTH_URL, { headers: headersOf(headers) }), token),
  requiresAuth: (pathname: string) => requiresAuth(pathname),
  sameOrigin: ({ url, headers }: { url: string; headers: unknown }) => sameOrigin(new Request(url, { headers: headersOf(headers) })),
  parseViewPath: (pathname: string) => parseViewPath(pathname),
  // the body is never read: a path that names no file is enough for the headers
  fileResponseHeaders: ({ file, download, page }: FileResponseInput) =>
    headerList(fileResponse({ ...file, path: `/nonexistent/security-fixtures/${file.name}`, size: 0, modified: "1970-01-01T00:00:00.000Z" }, download, page).headers),
  isPushServiceEndpoint: (endpoint: string) => isPushServiceEndpoint(new URL(endpoint)),
  parseSubscription: (value: unknown) => parseSubscription(value),
};
