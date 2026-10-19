import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { access, chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import test from "node:test";
import { browserSession } from "./browser-session.mjs";

const execute = promisify(execFile);

async function fixture(mode) {
  const directory = await mkdtemp(join(tmpdir(), "anatomy-lifecycle-"));
  const binary = join(directory, "chrome.mjs");
  const receipt = join(directory, "receipt.json");
  const page = join(directory, "figure.html");
  await writeFile(page, '<!doctype html><div class="iso-plate"><svg class="iso-svg" viewBox="0 0 40 30" width="40" height="30"><rect width="40" height="30"/></svg></div>');
  await writeFile(binary, `#!${process.execPath}
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
const profile=process.argv.find(arg=>arg.startsWith('--user-data-dir=')).slice(16);
const receipt=${JSON.stringify(receipt)};
const record=phase=>writeFileSync(receipt,JSON.stringify({pid:process.pid,profile,phase}));
const server=createServer((request,response)=>{
  record('request');
  if(${JSON.stringify(mode)}==='hang')return;
  response.end(JSON.stringify({webSocketDebuggerUrl:'ws://127.0.0.1:'+server.address().port+'/socket'}));
});
server.on('upgrade',(request,socket)=>{
  const key=createHash('sha1').update(request.headers['sec-websocket-key']+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\nSec-WebSocket-Accept: '+key+'\\r\\n\\r\\n');
  if(${JSON.stringify(mode)}==='disconnect')socket.once('data',()=>socket.end());
  if(${JSON.stringify(mode)}==='exit')setTimeout(()=>process.exit(7),100);
});
process.on('SIGTERM',()=>setTimeout(()=>{
  writeFileSync(join(profile,'last-write'),'stopped');
  record('stopped');
  process.exit(0);
},50));
server.listen(0,'127.0.0.1',()=>process.stderr.write('DevTools listening on ws://127.0.0.1:'+server.address().port+'/browser/test\\n'));
`);
  await chmod(binary, 0o755);
  const readReceipt = async () => JSON.parse(await readFile(receipt, "utf8"));
  const cleanup = async () => {
    const state = await readReceipt().catch(() => null);
    if (state) {
      try { process.kill(state.pid, "SIGKILL"); } catch {}
      await rm(state.profile, { recursive: true, force: true });
    }
    await rm(directory, { recursive: true, force: true });
  };
  return { directory, binary, receipt, page, readReceipt, cleanup };
}

async function waitForReceipt(f) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const state = await f.readReceipt().catch(() => null);
    if (state) return state;
    await delay(25);
  }
  throw new Error("Fake Chrome did not receive a request");
}

for (const name of ["capture", "drive", "turn-check"]) {
  test(`${name} stops Chrome and removes its profile when interrupted during page setup`, async () => {
    const f = await fixture("hang");
    let child;
    try {
      child = spawn(process.execPath, [`scripts/${name}.mjs`, f.page], { env: { ...process.env, CHROME_PATH: f.binary }, stdio: "ignore" });
      const ended = once(child, "exit");
      const state = await waitForReceipt(f);
      child.kill("SIGTERM");
      const [code] = await ended;
      assert.equal(code, 143);
      assert.equal((await f.readReceipt()).phase, "stopped");
      await assert.rejects(access(state.profile), { code: "ENOENT" });
      assert.throws(() => process.kill(state.pid, 0), { code: "ESRCH" });
    } finally {
      if (child?.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await f.cleanup();
    }
  });
}

test("disconnected CDP rejects pending commands and cleanup waits for the browser's last write", async () => {
  const f = await fixture("disconnect");
  let session;
  try {
    session = await browserSession(f.binary, "anatomy-session-test-", { close() {} });
    await assert.rejects(session.send("Never.reply"), /Chrome connection closed/);
    await session.close();
    const state = await f.readReceipt();
    assert.equal(state.phase, "stopped");
    await assert.rejects(access(state.profile), { code: "ENOENT" });
    await session.close();
  } finally {
    await session?.close();
    await f.cleanup();
  }
});

for (const wrapper of ["compatibility", "print", "lines"]) {
  test(`${wrapper} forwards interruption and waits for child cleanup`, async () => {
    const f = await fixture("hang");
    let child;
    try {
      const temp = join(f.directory, "temp");
      await mkdir(temp);
      const spec = join(f.directory, "sheet.mjs");
      await writeFile(spec, 'export default {page:"figure.html",views:{rest:{}}};');
      const args = wrapper === "print" ? ["scripts/print.mjs", spec] : wrapper === "lines" ? ["scripts/lines.mjs", f.page] : ["--import", "data:text/javascript,globalThis.WebSocket=undefined", "scripts/capture.mjs", f.page];
      child = spawn(process.execPath, args, { env: { ...process.env, CHROME_PATH: f.binary, TMPDIR: temp }, stdio: "ignore" });
      const ended = once(child, "exit");
      const state = await waitForReceipt(f);
      child.kill("SIGTERM");
      const [code] = await ended;
      assert.equal(code, 143);
      assert.equal((await f.readReceipt()).phase, "stopped");
      await assert.rejects(access(state.profile), { code: "ENOENT" });
      assert.deepEqual(await readdir(temp), []);
    } finally {
      if (child?.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await f.cleanup();
    }
  });
}

test("unexpected Chrome exit aborts idle waits promptly", async () => {
  const f = await fixture("exit");
  let session;
  try {
    session = await browserSession(f.binary, "anatomy-session-test-", { close() {} });
    const started = performance.now();
    await assert.rejects(delay(60000, undefined, { signal: session.signal }), { name: "AbortError" });
    assert.ok(performance.now() - started < 5000);
    await session.close();
    await assert.rejects(access((await f.readReceipt()).profile), { code: "ENOENT" });
  } finally {
    await session?.close();
    await f.cleanup();
  }
});

test("failed raster capture removes print logs, screenshots and browser profiles", async () => {
  const directory = await mkdtemp(join(tmpdir(), "anatomy-print-cleanup-"));
  try {
    const temp = join(directory, "temp");
    await mkdir(temp);
    const page = join(directory, "figure.html");
    await writeFile(page, '<!doctype html><div class="iso-plate"><svg class="iso-svg" viewBox="0 0 40 30" width="40" height="30"><rect width="40" height="30"/></svg></div>');
    const script = `import {capture} from ${JSON.stringify(new URL("print.mjs", import.meta.url).href)}; await capture({rasterSelector:'#missing',settle:0,views:{rest:{raster:true}}},process.argv[1]);`;
    await assert.rejects(execute(process.execPath, ["--input-type=module", "-e", script, page], { env: { ...process.env, TMPDIR: temp }, timeout: 30000 }), (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /drive.mjs failed/);
      return true;
    });
    assert.deepEqual(await readdir(temp), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
