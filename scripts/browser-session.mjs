import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromePort } from "./chrome-port.mjs";
import { accessFlags } from "./browser-access.mjs";

export function forwardSignals(child, onFailure = () => {}) {
  let timer;
  const failed = (error) => {
    if (!child.pid) {
      process.exitCode ||= 1;
      onFailure(error);
    }
  };
  const handlers = new Map(["SIGINT", "SIGTERM"].map((signal) => [signal, () => {
    process.exitCode = signal === "SIGINT" ? 130 : 143;
    try { child.kill(signal); } catch {}
    timer ??= setTimeout(() => {
      console.error(`Child cleanup failed; process ${child.pid} may still be running.`);
      child.unref();
      remove();
      onFailure(new Error("Child process did not stop"));
    }, 6000);
  }]));
  const remove = () => {
    clearTimeout(timer);
    for (const [signal, handler] of handlers) process.off(signal, handler);
    child.off("error", failed);
  };
  for (const [signal, handler] of handlers) process.on(signal, handler);
  child.on("error", failed);
  child.once("close", remove);
  return remove;
}

export async function browserSession(binary, prefix, access) {
  let profile, chrome, socket, closing;
  let stopped = Promise.resolve();
  let exited = false;
  let sequence = 0;
  const pending = new Map();
  const controller = new AbortController();
  const rejectPending = () => {
    for (const fail of pending.values()) fail(new Error("Chrome connection closed"));
    pending.clear();
  };
  const waitForExit = async (ms) => {
    let timer;
    try { return await Promise.race([stopped.then(() => true), new Promise((done) => { timer = setTimeout(() => done(false), ms); })]); }
    finally { clearTimeout(timer); }
  };
  const handlers = new Map(["SIGINT", "SIGTERM"].map((signal) => [signal, () => {
    const code = signal === "SIGINT" ? 130 : 143;
    close().finally(() => process.exit(code)).catch(() => {});
  }]));
  const close = () => closing ??= (async () => {
    controller.abort();
    rejectPending();
    const failures = [];
    try { socket?.close(); } catch (error) { failures.push(error); }
    try { await access.close(); } catch (error) { failures.push(error); }
    if (chrome && !exited) {
      try { chrome.kill("SIGTERM"); } catch (error) { failures.push(error); }
      if (!await waitForExit(2000)) {
        try { chrome.kill("SIGKILL"); } catch (error) { failures.push(error); }
      }
      if (!await waitForExit(2000)) {
        failures.push(new Error("Chrome did not exit; its profile was retained"));
        chrome.unref();
        chrome.stdout?.destroy();
        chrome.stderr?.destroy();
      }
    }
    if (profile && (!chrome || exited)) {
      try { rmSync(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
      catch (error) { failures.push(error); }
    }
    for (const [signal, handler] of handlers) process.off(signal, handler);
    if (failures.length) {
      console.error(`Browser cleanup failed; check process ${chrome?.pid ?? "none"} and temporary profile ${profile ?? "none"}.`);
      throw new AggregateError(failures, "Browser cleanup failed");
    }
  })();
  try {
    profile = mkdtempSync(join(tmpdir(), prefix));
    chrome = spawn(binary, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--hide-scrollbars", ...accessFlags, "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist", "about:blank"]);
    stopped = new Promise((done) => {
      chrome.once("exit", () => { exited = true; queueMicrotask(() => controller.abort()); rejectPending(); done(); });
      chrome.on("error", () => {
        queueMicrotask(() => controller.abort());
        rejectPending();
        if (!chrome.pid) { exited = true; done(); }
      });
    });
    for (const [signal, handler] of handlers) process.on(signal, handler);
    const port = await chromePort(chrome, controller.signal);
    const response = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]) });
    if (!response.ok) throw new Error("Chrome could not create a page");
    const page = await response.json();
    socket = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((done, fail) => {
      const clean = () => {
        clearTimeout(timer);
        socket.removeEventListener("open", opened);
        socket.removeEventListener("error", failed);
        socket.removeEventListener("close", failed);
        controller.signal.removeEventListener("abort", failed);
      };
      const opened = () => { clean(); done(); };
      const failed = () => { clean(); fail(new Error("Chrome connection failed")); };
      const timer = setTimeout(failed, 10000);
      socket.addEventListener("open", opened);
      socket.addEventListener("error", failed);
      socket.addEventListener("close", failed);
      controller.signal.addEventListener("abort", failed, { once: true });
      if (controller.signal.aborted) failed();
    });
    const disconnected = () => { controller.abort(); rejectPending(); };
    socket.addEventListener("close", disconnected);
    socket.addEventListener("error", disconnected);
    socket.addEventListener("message", (message) => {
      const reply = JSON.parse(message.data);
      if (reply.id) pending.get(reply.id)?.(null, reply);
    });
    const send = (method, params = {}, patience = 60000) => new Promise((done, fail) => {
      if (socket.readyState !== WebSocket.OPEN || controller.signal.aborted) { fail(new Error("Chrome connection closed")); return; }
      const id = ++sequence;
      const finish = (error, reply) => {
        clearTimeout(timer);
        pending.delete(id);
        if (error) fail(error); else done(reply);
      };
      const timer = setTimeout(() => finish(new Error(`Chrome did not answer ${method} within ${Math.round(patience / 1000)} s`)), patience);
      pending.set(id, finish);
      try { socket.send(JSON.stringify({ id, method, params })); } catch (error) { finish(error); }
    });
    return { socket, send, close, signal: controller.signal };
  } catch (error) {
    await close();
    throw error;
  }
}
