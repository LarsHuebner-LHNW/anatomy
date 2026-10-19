import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { capture } from "./print.mjs";

const execute = promisify(execFile);
const sentinel = "private-browser-diagnostic-7fa9";

async function run(args) {
  try {
    return { code: 0, ...await execute(process.execPath, args, { timeout: 30000 }) };
  } catch (error) {
    return { code: error.code, stdout: error.stdout, stderr: error.stderr };
  }
}

test("drive hides browser content by default and preserves actions and failure status", async () => {
  const directory = await mkdtemp(join(tmpdir(), "anatomy-private-drive-"));
  try {
    const page = join(directory, "figure.html");
    const actions = join(directory, "actions.json");
    await writeFile(page, `<!doctype html><div class="iso-plate"><span data-readout>${sentinel}</span></div><script>console.warn(${JSON.stringify(sentinel)})</script>`);
    await writeFile(actions, JSON.stringify([["eval", `window.privateValue=${JSON.stringify(sentinel)}`], ["until", `window.privateValue===${JSON.stringify(sentinel)}`, 100]]));
    const hidden = await run(["scripts/drive.mjs", page, "--actions", actions]);
    assert.equal(hidden.code, 0);
    assert.match(hidden.stdout, /eval: result suppressed/);
    assert.match(hidden.stdout, /browser warnings\/errors: 1/);
    assert.doesNotMatch(hidden.stdout + hidden.stderr, new RegExp(sentinel));

    await writeFile(actions, JSON.stringify([["eval", `(()=>{throw new Error(${JSON.stringify(sentinel)})})()`]]));
    const failed = await run(["scripts/drive.mjs", page, "--actions", actions]);
    assert.equal(failed.code, 1);
    assert.match(failed.stderr, /Drive failed/);
    assert.doesNotMatch(failed.stdout + failed.stderr, new RegExp(sentinel));

    const visible = await run(["scripts/drive.mjs", page, "--actions", actions, "--diagnostics"]);
    assert.equal(visible.code, 1);
    assert.match(visible.stderr, new RegExp(sentinel));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("capture hides readouts and browser messages unless diagnostics are requested", async () => {
  const directory = await mkdtemp(join(tmpdir(), "anatomy-private-capture-"));
  try {
    const page = join(directory, "figure.html");
    const output = join(directory, "figure.png");
    await writeFile(page, `<!doctype html><div class="iso-plate" style="width:40px;height:30px"><span data-readout>${sentinel}</span></div><script>console.warn(${JSON.stringify(sentinel)})</script>`);
    const args = ["scripts/capture.mjs", page, "--out", output, "--wait", "0"];
    const hidden = await run(args);
    assert.equal(hidden.code, 0, hidden.stderr);
    assert.match(hidden.stdout, /browser warnings\/errors: 1/);
    assert.doesNotMatch(hidden.stdout + hidden.stderr, new RegExp(sentinel));

    const visible = await run([...args, "--diagnostics"]);
    assert.equal(visible.code, 0, visible.stderr);
    assert.match(visible.stdout + visible.stderr, new RegExp(sentinel));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("turn-check hides browser messages and page theme unless diagnostics are requested", async () => {
  const directory = await mkdtemp(join(tmpdir(), "anatomy-private-turn-check-"));
  try {
    const page = join(directory, "figure.html");
    await writeFile(page, `<!doctype html><div class="iso-turn"><svg data-live="test" viewBox="0 0 40 30"></svg></div><script>window.__isoTurn={controller:{},set(){console.warn(${JSON.stringify(sentinel)})}}</script>`);
    const hidden = await run(["scripts/turn-check.mjs", page]);
    assert.equal(hidden.code, 1, hidden.stderr);
    assert.match(hidden.stdout, /live layers 1/);
    assert.match(hidden.stdout, /browser warnings\/errors: 1/);
    assert.doesNotMatch(hidden.stdout + hidden.stderr, new RegExp(sentinel));

    const visible = await run(["scripts/turn-check.mjs", page, "--diagnostics"]);
    assert.equal(visible.code, 1, visible.stderr);
    assert.match(visible.stdout + visible.stderr, new RegExp(sentinel));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("print reports missing layers without exposing the configured selector", async () => {
  const directory = await mkdtemp(join(tmpdir(), "anatomy-private-print-"));
  try {
    const page = join(directory, "figure.html");
    await writeFile(page, "<!doctype html><div>Figure</div>");
    await assert.rejects(capture({ layers: `.${sentinel}`, views: { rest: {} } }, page), (error) => {
      assert.equal(error.message, "No matching figure layers");
      assert.doesNotMatch(error.message, new RegExp(sentinel));
      return true;
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
