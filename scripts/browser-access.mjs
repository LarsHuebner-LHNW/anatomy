import { readFileSync, realpathSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { basename, dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const accessFlags = ["--disable-background-networking", "--dns-prefetch-disable", "--force-webrtc-ip-handling-policy=disable_non_proxied_udp"];

function policy(origin) {
  return `default-src 'self' data: blob:; script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:; style-src 'self' 'unsafe-inline'; connect-src ${origin}; worker-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'self'; form-action 'none'; sandbox allow-scripts allow-same-origin allow-forms`;
}

function inside(root, path) {
  const part = relative(root, path);
  return part !== ".." && !part.startsWith(`..${sep}`) && !isAbsolute(part);
}

function hidden(path) {
  return path.split(/[\\/]/).some((part) => part.startsWith("."));
}

export async function browserTarget(target, allowOrigin) {
  if (/^https?:/i.test(target)) {
    const url = new URL(target);
    if (!["127.0.0.1", "[::1]"].includes(url.hostname) || url.username || url.password || allowOrigin !== url.origin) throw new Error("Browser URLs require a loopback IP and --allow-origin matching the exact origin");
    return { url: url.href, origin: url.origin, close() {} };
  }
  if (allowOrigin !== undefined) throw new Error("--allow-origin is only for an explicit loopback URL");
  if (/^[a-z][a-z\d+.-]*:/i.test(target) && !/^file:/i.test(target) && !/^[a-z]:[\\/]/i.test(target)) throw new Error("Browser targets must be local files or explicitly allowed loopback URLs");
  const file = realpathSync(/^file:/i.test(target) ? fileURLToPath(target) : resolve(target));
  if (!statSync(file).isFile()) throw new Error("Browser target must be a file");
  const root = dirname(file);
  const types = { ".html": "text/html", ".svg": "image/svg+xml", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".woff": "font/woff", ".woff2": "font/woff2" };
  let origin;
  const server = createServer((request, response) => {
    response.setHeader("Content-Security-Policy", policy(origin));
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    try {
      if (request.headers.host !== new URL(origin).host || !["GET", "HEAD"].includes(request.method)) throw new Error();
      const path = decodeURIComponent(request.url.split(/[?#]/)[0]);
      if (path.includes("\0") || path.includes("\\") || hidden(path)) throw new Error();
      const candidate = resolve(root, `.${path}`);
      if (!inside(root, candidate)) throw new Error();
      const actual = realpathSync(candidate);
      if (!inside(root, actual) || hidden(relative(root, actual)) || !statSync(actual).isFile()) throw new Error();
      const data = readFileSync(actual);
      response.setHeader("Content-Type", types[extname(actual).toLowerCase()] ?? "application/octet-stream");
      response.end(request.method === "HEAD" ? undefined : data);
    } catch {
      response.writeHead(403);
      response.end();
    }
  });
  await new Promise((done, fail) => { server.once("error", fail); server.listen(0, "127.0.0.1", done); });
  origin = `http://127.0.0.1:${server.address().port}`;
  server.unref();
  return { url: `${origin}/${encodeURIComponent(basename(file))}`, origin, close() { server.closeAllConnections(); return new Promise((done, fail) => server.close((error) => error ? fail(error) : done())); } };
}

export async function restrictBrowser(socket, send, origin) {
  let failure;
  const checked = async (method, params) => {
    const reply = await send(method, params);
    if (reply.error) throw new Error(`Browser access policy failed: ${reply.error.message}`);
    return reply;
  };
  socket.addEventListener("message", (message) => {
    const { method, params } = JSON.parse(message.data);
    if (method !== "Fetch.requestPaused") return;
    const handle = async () => {
      const url = new URL(params.request.url);
      const allowed = url.origin === origin || ["data:", "blob:"].includes(url.protocol);
      if (!allowed) return checked("Fetch.failRequest", { requestId: params.requestId, errorReason: "BlockedByClient" });
      if (params.responseStatusCode && params.resourceType === "Document") {
        if ([204, 205].includes(params.responseStatusCode) || (params.responseStatusCode >= 300 && params.responseStatusCode < 400)) return checked("Fetch.continueRequest", { requestId: params.requestId });
        const body = (await checked("Fetch.getResponseBody", { requestId: params.requestId })).result;
        const headers = (params.responseHeaders ?? []).filter(({ name }) => !/^(content-length|content-encoding|transfer-encoding)$/i.test(name));
        return checked("Fetch.fulfillRequest", { requestId: params.requestId, responseCode: params.responseStatusCode, responseHeaders: [...headers, { name: "Content-Security-Policy", value: policy(origin) }], body: body.base64Encoded ? body.body : Buffer.from(body.body).toString("base64") });
      }
      return checked("Fetch.continueRequest", { requestId: params.requestId, interceptResponse: params.resourceType === "Document" });
    };
    handle().catch((error) => { failure = error; socket.close(); });
  });
  await checked("Network.enable");
  await checked("Network.setCacheDisabled", { cacheDisabled: true });
  await checked("Network.setBypassServiceWorker", { bypass: true });
  await checked("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] });
  return () => { if (failure) throw failure; };
}
