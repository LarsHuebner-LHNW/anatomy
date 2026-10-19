import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { browserTarget } from "./browser-access.mjs";

const execute = promisify(execFile);
const drive = fileURLToPath(new URL("drive.mjs", import.meta.url));
const listen = (server) => new Promise((done) => server.listen(0, "127.0.0.1", done));
const close = (server) => new Promise((done) => { server.closeAllConnections(); server.close(done); });

test("targets reject public URLs and require an exact explicit loopback origin", async () => {
  for (const [target, origin] of [["https://example.com/", "https://example.com"], ["http://127.0.0.1:3000/"], ["http://127.0.0.1:3000/", "http://127.0.0.1:3001"], ["http://localhost:3000/", "http://localhost:3000"], ["data:text/html,private"]]) await assert.rejects(browserTarget(target, origin));
  const target = await browserTarget("http://127.0.0.1:3000/figure?a=1", "http://127.0.0.1:3000");
  assert.equal(target.url, "http://127.0.0.1:3000/figure?a=1");
});

test("local serving permits relative assets and rejects traversal and symlink escapes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "anatomy-access-"));
  let target;
  try {
    const root = join(directory, "figure");
    await mkdir(root);
    await writeFile(join(root, "figure space.html"), "<p>Figure</p>");
    await writeFile(join(root, "asset.js"), "window.assetLoaded=true");
    await writeFile(join(directory, "private.txt"), "private");
    await writeFile(join(root, ".env"), "private");
    await symlink(join(directory, "private.txt"), join(root, "escape.txt"));
    await symlink(join(root, ".env"), join(root, "hidden.txt"));
    target = await browserTarget(pathToFileURL(join(root, "figure space.html")).href);
    assert.match(await (await fetch(target.url)).text(), /Figure/);
    assert.match(await (await fetch(`${target.origin}/asset.js`)).text(), /assetLoaded/);
    for (const path of ["/escape.txt", "/%2e%2e%2fprivate.txt", "/..%5cprivate.txt", "/.env", "/hidden.txt"]) {
      const status = await new Promise((done, fail) => { request(`${target.origin}${path}`, (response) => { response.resume(); done(response.statusCode); }).on("error", fail).end(); });
      assert.equal(status, 403, path);
    }
    assert.equal((await fetch(target.url)).headers.get("cache-control"), "no-store");
  } finally {
    target?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("browser blocks cross-origin resources, redirects, WebSockets, workers, popups and navigation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "anatomy-egress-"));
  let received = 0;
  const sink = createServer((request, response) => { received++; response.end("unexpected"); });
  sink.on("upgrade", (request, socket) => { received++; socket.destroy(); });
  await listen(sink);
  const denied = `http://127.0.0.1:${sink.address().port}`;
  const html = `<!doctype html><link rel="stylesheet" href="${denied}/style"><script src="${denied}/script"></script><script src="/asset.js"></script><img src="${denied}/image"><iframe src="${denied}/frame"></iframe><div class="iso-plate" style="width:100px;height:100px">Figure</div><script>
window.results=Promise.all([
fetch('/asset.js').then(r=>r.ok),
fetch('${denied}/fetch').then(()=>false,()=>true),
fetch('/redirect').then(()=>false,()=>true),
new Promise(done=>{const ws=new WebSocket('${denied.replace('http:', 'ws:')}/socket');ws.onerror=()=>done(true);ws.onopen=()=>done(false)}),
new Promise(done=>{const ws=new WebSocket(location.origin.replace('http:', 'ws:')+'/socket');ws.onerror=()=>done(true);ws.onopen=()=>{ws.close();done(false)}}),
Promise.resolve(window.open('${denied}/popup')===null),
new Promise(done=>{addEventListener('securitypolicyviolation',e=>{if(e.violatedDirective==='worker-src')done(true)});try{const w=new Worker(URL.createObjectURL(new Blob(["postMessage('started');fetch('${denied}/worker')"],{type:'text/javascript'})));w.onerror=()=>done(true);w.onmessage=()=>done(false)}catch{done(true)}})
].map((p,i)=>Promise.race([p,new Promise(done=>setTimeout(()=>done('timeout_'+i),2000))])));navigator.sendBeacon('${denied}/beacon','private');
</script>`;
  const server = createServer((request, response) => {
    if (request.url === "/redirect") { response.writeHead(302, { Location: `${denied}/redirect` }); response.end(); }
    else if (request.url === "/asset.js") { response.setHeader("Content-Type", "text/javascript"); response.end("window.assetLoaded=true"); }
    else { response.setHeader("Content-Type", "text/html"); response.end(html); }
  });
  let upgrades = 0;
  server.on("upgrade", (request, socket) => { upgrades++; socket.destroy(); });
  await listen(server);
  try {
    const origin = `http://127.0.0.1:${server.address().port}`;
    const actions = [["eval", "results.then(r=>[window.assetLoaded,...r])"], ["eval", `location.href='${denied}/navigation'`], ["wait", 300]];
    const result = await execute(process.execPath, [drive, `${origin}/`, JSON.stringify(actions), "--allow-origin", origin, "--diagnostics"], { timeout: 30000 });
    assert.match(result.stdout, /eval: \[true,true,true,true,true,true,true,true\]/);
    assert.equal(received, 0);
    assert.equal(upgrades, 0);
    await writeFile(join(directory, "asset.js"), "window.assetLoaded=true");
    await writeFile(join(directory, "figure.html"), html.replace("fetch('/redirect').then(()=>false,()=>true)", "Promise.resolve(true)"));
    const local = await execute(process.execPath, [drive, join(directory, "figure.html"), JSON.stringify([["eval", "results.then(r=>[window.assetLoaded,...r])"]]), "--diagnostics"], { timeout: 30000 });
    assert.match(local.stdout, /eval: \[true,true,true,true,true,true,true,true\]/);
    assert.equal(received, 0);
  } finally {
    await close(server);
    await close(sink);
    await rm(directory, { recursive: true, force: true });
  }
});

test("PDF rendering uses the same resource restrictions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "anatomy-pdf-access-"));
  let received = 0;
  const sink = createServer((request, response) => { received++; response.end("unexpected"); });
  await listen(sink);
  try {
    const html = join(directory, "figure.html");
    await writeFile(html, `<!doctype html><style>@page{size:100mm 100mm;margin:5mm}</style><h1>Private figure</h1><img src="http://127.0.0.1:${sink.address().port}/image">`);
    const script = `import { printPdf } from ${JSON.stringify(new URL("print.mjs", import.meta.url).href)}; console.log(JSON.stringify(printPdf(process.argv[1], process.argv[2])));`;
    const pdf = join(directory, "figure.pdf");
    const { stdout } = await execute(process.execPath, ["--input-type=module", "-e", script, html, pdf], { timeout: 30000 });
    const result = JSON.parse(stdout);
    assert.equal(result.pages, 1);
    assert.ok(result.bytes > 1000);
    assert.equal((await readFile(pdf)).subarray(0, 5).toString(), "%PDF-");
    assert.equal(received, 0);
  } finally {
    await close(sink);
    await rm(directory, { recursive: true, force: true });
  }
});
