import { spawn } from "node:child_process";

const ACTIONS = new Set(["start", "pause", "resume", "stop", "status"]);
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

function boundedNumber(value, fallback, minimum, maximum, label) {
  const numeric = value === undefined || value === null || value === "" ? fallback : Number(value);
  if (!Number.isFinite(numeric) || numeric < minimum || numeric > maximum) {
    throw new RangeError(`${label} must be between ${minimum} and ${maximum}.`);
  }
  return numeric;
}

function loopbackUrl(value, label) {
  if (value === undefined || value === null || value === "") return null;
  let parsed;
  try {
    parsed = new URL(String(value));
  } catch {
    throw new TypeError(`${label} must be a valid local URL.`);
  }
  const hostname = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const protocol = parsed.protocol.toLowerCase();
  const allowedProtocols = label === "CDP URL"
    ? new Set(["http:", "https:", "ws:", "wss:"])
    : new Set(["http:", "https:"]);
  if (!LOOPBACK_HOSTS.has(hostname) || !allowedProtocols.has(protocol)) {
    throw new TypeError(`${label} must point to a loopback endpoint.`);
  }
  return String(value);
}

function bvidValue(value) {
  if (value === undefined || value === null || value === "") return null;
  const bvid = String(value).trim();
  if (!/^BV[0-9A-Za-z]+$/.test(bvid)) throw new TypeError("bvid must be a Bilibili BV identifier.");
  return bvid;
}

/**
 * Build arguments for the existing read-only CDP launcher.
 * This function is intentionally pure so the panel control contract can be tested without a browser.
 */
export function buildLauncherArgs(action, options = {}) {
  const mode = String(action || "").trim().toLowerCase();
  if (!ACTIONS.has(mode)) throw new TypeError(`Unsupported observer action: ${mode || "(empty)"}.`);

  const args = [];
  const cdpUrl = loopbackUrl(options.cdpUrl, "CDP URL");
  const bridgeUrl = loopbackUrl(options.bridgeUrl, "Bridge URL");
  const bvid = bvidValue(options.bvid);
  if (cdpUrl) args.push("--cdp-url", cdpUrl);
  if (bridgeUrl && mode === "start") args.push("--bridge-url", bridgeUrl);
  if (bvid) args.push("--bvid", bvid);

  if (mode === "start") {
    const intervalSeconds = boundedNumber(options.intervalSeconds, 15, 10, 20, "intervalSeconds");
    const syncIntervalMs = boundedNumber(options.syncIntervalMs, 1000, 500, 10000, "syncIntervalMs");
    args.push("--interval-seconds", String(intervalSeconds), "--sync-interval-ms", String(syncIntervalMs));
  } else if (mode === "pause") {
    args.push("--pause");
  } else if (mode === "resume") {
    args.push("--resume");
  } else if (mode === "stop") {
    args.push("--stop");
  } else {
    args.push("--status");
  }
  return args;
}

function sanitizeLauncherResult(value) {
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(sanitizeLauncherResult);
  const result = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === "page" && typeof child === "string") {
      try {
        const url = new URL(child);
        result[key] = `${url.origin}${url.pathname}`;
      } catch {
        result[key] = child.split(/[?#]/, 1)[0];
      }
    } else {
      result[key] = sanitizeLauncherResult(child);
    }
  }
  return result;
}

function parseLauncherOutput(stdout) {
  const text = String(stdout || "").trim();
  if (!text) return null;
  try {
    return sanitizeLauncherResult(JSON.parse(text));
  } catch {
    const starts = [];
    for (let index = text.indexOf("{"); index >= 0; index = text.indexOf("{", index + 1)) starts.push(index);
    for (let index = starts.length - 1; index >= 0; index -= 1) {
      try {
        return sanitizeLauncherResult(JSON.parse(text.slice(starts[index])));
      } catch {
        // Keep looking for the final JSON object after any launcher diagnostics.
      }
    }
  }
  return null;
}

/** Run the local launcher and return its structured, redacted result. */
export function runObserverLauncher({ launcherPath, action, cdpUrl, bridgeUrl, bvid, intervalSeconds, syncIntervalMs, timeoutMs = 45000 } = {}) {
  if (!launcherPath) throw new TypeError("launcherPath is required.");
  const args = buildLauncherArgs(action, { cdpUrl, bridgeUrl, bvid, intervalSeconds, syncIntervalMs });
  const timeout = boundedNumber(timeoutMs, 45000, 5000, 120000, "timeoutMs");
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const child = spawn(process.execPath, [launcherPath, ...args], {
      cwd: launcherPath.replace(/[\\/]+scripts[\\/]start-observer\.mjs$/i, ""),
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill(); } catch {}
      reject(new Error("The observer launcher timed out."));
    }, timeout);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.once("error", error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const parsed = parseLauncherOutput(stdout);
      if (code !== 0) {
        const detail = String(stderr || stdout || `exit code ${code ?? "unknown"}`).trim().replace(/^Observer launcher failed:\s*/i, "").slice(0, 1000);
        reject(new Error(`Observer launcher failed${signal ? ` (${signal})` : ""}: ${detail}`));
        return;
      }
      if (!parsed) {
        reject(new Error("Observer launcher returned no structured result."));
        return;
      }
      resolve(parsed);
    });
  });
}
