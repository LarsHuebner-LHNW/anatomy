export async function chromePort(chrome, signal) {
  return new Promise((done, fail) => {
    let text = "";
    const clean = () => {
      clearTimeout(timer);
      chrome.stderr.off("data", data);
      chrome.off("error", error);
      chrome.off("exit", exited);
      signal?.removeEventListener("abort", aborted);
    };
    const error = (cause) => { clean(); fail(cause); };
    const exited = (code, signal) => error(new Error(`Chrome exited before startup: ${code ?? signal}`));
    const aborted = () => error(new Error("Chrome startup interrupted"));
    const data = (chunk) => {
      text += chunk;
      const match = text.match(/DevTools listening on ws:\/\/[^:]+:(\d+)\//);
      if (match) { clean(); done(Number(match[1])); }
    };
    const timer = setTimeout(() => error(new Error("Chrome did not start")), 20000);
    chrome.stderr.on("data", data);
    chrome.on("error", error);
    chrome.on("exit", exited);
    signal?.addEventListener("abort", aborted, { once: true });
    if (signal?.aborted) aborted();
  });
}
