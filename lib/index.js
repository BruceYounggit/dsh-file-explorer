// Host half of dsh-file-explorer.
//
// Two read-only services, both bound to 127.0.0.1:
//   1. one rclone HTTP server per configured local source (plain directory
//      listings, useful for quick browsing), and
//   2. a small tree API for one remote directory: JSON listings via
//      `rclone lsjson` and byte ranges via `rclone cat`, which is what makes
//      the VSCode-like page (lib/explorer.html) able to preview images inline
//      and stream videos without downloading them.
import { spawn, execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import http from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const name = "file-explorer";

const DEFAULT_CONFIG = {
  /** Directory the tree page starts from; it is only the default, not a boundary. */
  treeRoot: "/",
  /** Set true to refuse paths outside treeRoot. */
  restrictToTreeRoot: false,
  /** Set true to accept dropped files through POST /api/upload. */
  allowUpload: true,
  /** Set true to allow rename, move, delete and mkdir. */
  allowWrite: true,
  /** Local port serving the tree page and its API. */
  treePort: 8910,
  /** SFTP host backing the tree page; empty host disables the tree API. */
  ssh: {
    host: "",
    port: 22,
    user: "root",
    keyFile: "",
    knownHosts: "",
    remoteName: "SSH",
  },
  /** Plain rclone HTTP sources shown as extra tabs. */
  sources: [],
};

const MIME = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
  webp: "image/webp", bmp: "image/bmp", svg: "image/svg+xml", ico: "image/x-icon",
  avif: "image/avif",
  mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime", mkv: "video/x-matroska",
  avi: "video/x-msvideo", m4v: "video/mp4",
  mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", m4a: "audio/mp4", flac: "audio/flac",
  pdf: "application/pdf", json: "application/json", txt: "text/plain; charset=utf-8",
  md: "text/plain; charset=utf-8", csv: "text/plain; charset=utf-8",
  yml: "text/plain; charset=utf-8", yaml: "text/plain; charset=utf-8",
  html: "text/html; charset=utf-8", css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8", ts: "text/plain; charset=utf-8",
  py: "text/plain; charset=utf-8", sh: "text/plain; charset=utf-8",
  log: "text/plain; charset=utf-8",
};

function findRclone() {
  const candidates = [
    process.env.DSH_RCLONE,
    "C:\\ProgramData\\chocolatey\\bin\\rclone.exe",
    "rclone",
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (candidate === "rclone" || existsSync(candidate)) return candidate;
  }
  return "rclone";
}

const RCLONE = findRclone();

/**
 * Optional user configuration outside the profile patch:
 * `$DSH_HOME/file-explorer.json` (default `~/.dsh/file-explorer.json`).
 * The loader entry's own `config` still wins over this file.
 */
function readUserConfig() {
  const home = process.env.DSH_HOME || join(homedir(), ".dsh");
  const file = join(home, "file-explorer.json");
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    console.error("[file-explorer] ignoring " + file + ": " + error.message);
    return {};
  }
}

function resolveConfig(config) {
  const fileConfig = readUserConfig();
  const merged = { ...DEFAULT_CONFIG, ...fileConfig, ...(config || {}) };
  merged.ssh = {
    ...DEFAULT_CONFIG.ssh,
    ...((fileConfig && fileConfig.ssh) || {}),
    ...((config && config.ssh) || {}),
  };
  merged.sources = Array.isArray(merged.sources) ? merged.sources : [];
  return merged;
}

function sshEnv(ssh) {
  const base = "RCLONE_CONFIG_" + String(ssh.remoteName || "SSH").toUpperCase() + "_";
  return {
    [base + "TYPE"]: "sftp",
    [base + "HOST"]: ssh.host,
    [base + "PORT"]: String(ssh.port || 22),
    [base + "USER"]: ssh.user || "root",
    [base + "KEY_FILE"]: ssh.keyFile || "",
    [base + "KNOWN_HOSTS_FILE"]: ssh.knownHosts || "",
    [base + "SHELL_TYPE"]: "none",
  };
}

function run(args, env) {
  return new Promise((resolve, reject) => {
    execFile(RCLONE, args, {
      windowsHide: true,
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, ...(env || {}) },
    }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error((stderr || error.message || "rclone failed").trim().slice(0, 400)));
        return;
      }
      resolve(stdout);
    });
  });
}

function extOf(name) {
  const index = name.lastIndexOf(".");
  return index < 0 ? "" : name.slice(index + 1).toLowerCase();
}

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
}

function createTreeServer(state) {
  const { config, env, root, port } = state;
  const statCache = new Map();

  async function statOf(path) {
    const cached = statCache.get(path);
    if (cached && Date.now() - cached.at < 30000) return cached.value;
    const text = await run(["lsjson", "--stat", "SSH:" + path], env);
    const value = JSON.parse(text);
    statCache.set(path, { at: Date.now(), value });
    return value;
  }

  async function listDir(path) {
    const rows = JSON.parse(await run(["lsjson", "SSH:" + path], env));
    const entries = rows.map((row) => ({
      name: row.Name,
      path: path.replace(/\/+$/, "") + "/" + row.Name,
      dir: Boolean(row.IsDir),
      size: row.Size || 0,
      mtime: row.ModTime || "",
    }));
    entries.sort((a, b) => {
      if (a.dir !== b.dir) return a.dir ? -1 : 1;
      return a.name.localeCompare(b.name, "zh-CN");
    });
    return entries;
  }

  function insideRoot(path) {
    if (!path.startsWith("/")) return false;
    if (!config.restrictToTreeRoot) return true;
    const normalized = path.replace(/\/+$/, "") || "/";
    const base = root.replace(/\/+$/, "") || "/";
    if (base === "/") return normalized.startsWith("/");
    return normalized === base || normalized.startsWith(base + "/");
  }

  function serveIndex(response) {
    const file = fileURLToPath(new URL("./explorer.html", import.meta.url));
    let template = "";
    try {
      template = readFileSync(file, "utf8");
    } catch (error) {
      response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      response.end("explorer.html is missing: " + error.message);
      return;
    }
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    });
    response.end(template.replace("__ROOT__", JSON.stringify(root)));
  }

  function serveFile(request, response, url) {
    const path = url.searchParams.get("path") || "";
    if (!insideRoot(path)) {
      sendJson(response, 403, { error: "path outside the configured root" });
      return;
    }
    const limit = Number(url.searchParams.get("limit") || 0);

    statOf(path).then((info) => {
      if (info.IsDir) {
        sendJson(response, 400, { error: "is a directory" });
        return;
      }
      const size = Number(info.Size) || 0;
      const headers = {
        "content-type": MIME[extOf(path)] || "application/octet-stream",
        "accept-ranges": "bytes",
        "cache-control": "no-store",
      };

      let start = 0;
      let end = size - 1;
      let status = 200;
      const range = request.headers.range;
      if (range) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(String(range).trim());
        if (match) {
          if (match[1]) start = Number(match[1]);
          if (match[2]) end = Number(match[2]);
          if (!match[1] && match[2]) {
            start = Math.max(0, size - Number(match[2]));
            end = size - 1;
          }
          start = Math.max(0, Math.min(start, Math.max(0, size - 1)));
          end = Math.max(start, Math.min(end, size - 1));
          status = 206;
          headers["content-range"] = "bytes " + start + "-" + end + "/" + size;
        }
      }
      if (limit > 0) {
        end = Math.min(end, start + limit - 1);
        status = range ? 206 : 200;
      }
      headers["content-length"] = String(Math.max(0, end - start + 1));

      if (request.method === "HEAD") {
        response.writeHead(status, headers);
        response.end();
        return;
      }

      response.writeHead(status, headers);
      const cat = spawn(RCLONE, [
        "cat",
        "--offset", String(start),
        "--count", String(Math.max(0, end - start + 1)),
        "SSH:" + path,
      ], {
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"],
        env: { ...process.env, ...env },
      });
      cat.stdout.pipe(response);
      cat.on("error", () => {
        try { response.destroy(); } catch (error) { /* ignore */ }
      });
      request.on("close", () => {
        try { cat.kill(); } catch (error) { /* ignore */ }
      });
    }).catch((error) => {
      sendJson(response, 404, { error: error.message });
    });
  }

  /**
   * Run one write command (`mkdir`, `moveto`, `deletefile`, `purge`) and answer JSON.
   * Every path is checked against the configured root before rclone sees it.
   */
  function serveWrite(request, response, url, action) {
    if (!config.allowWrite) {
      sendJson(response, 403, { error: "write operations are disabled (allowWrite: false)" });
      return;
    }
    const path = url.searchParams.get("path") || "";
    const name = url.searchParams.get("name") || "";
    const to = url.searchParams.get("to") || "";
    if (!path.startsWith("/")) {
      sendJson(response, 400, { error: "path is required" });
      return;
    }
    if (!insideRoot(path)) {
      sendJson(response, 403, { error: "path outside the configured root" });
      return;
    }

    const basename = path.replace(/\/+$/, "").split("/").pop();
    let args;
    let result = path;

    if (action === "mkdir") {
      if (!name || /[\\/]/.test(name) || name === "." || name === "..") {
        sendJson(response, 400, { error: "invalid folder name" });
        return;
      }
      result = path.replace(/\/+$/, "") + "/" + name;
      args = ["mkdir", "SSH:" + result];
    } else if (action === "rename") {
      if (!name || /[\\/]/.test(name) || name === "." || name === "..") {
        sendJson(response, 400, { error: "invalid name" });
        return;
      }
      const dir = path.replace(/\/[^/]+$/, "");
      result = (dir || "") + "/" + name;
      args = ["moveto", "SSH:" + path, "SSH:" + result];
    } else if (action === "move") {
      if (!to.startsWith("/") || !insideRoot(to)) {
        sendJson(response, 400, { error: "invalid destination" });
        return;
      }
      result = to.replace(/\/+$/, "") + "/" + basename;
      args = ["moveto", "SSH:" + path, "SSH:" + result];
    } else {
      sendJson(response, 404, { error: "unknown action" });
      return;
    }

    run(args, env).then(() => {
      statCache.delete(path);
      statCache.delete(result);
      sendJson(response, 200, { ok: true, path: result });
    }).catch((error) => {
      sendJson(response, 500, { error: error.message });
    });
  }

  /** Delete a file or a whole directory; the stat decides which rclone command to use. */
  function serveDelete(request, response, url) {
    if (!config.allowWrite) {
      sendJson(response, 403, { error: "write operations are disabled (allowWrite: false)" });
      return;
    }
    const path = url.searchParams.get("path") || "";
    if (!path.startsWith("/") || !insideRoot(path)) {
      sendJson(response, 403, { error: "path outside the configured root" });
      return;
    }
    statOf(path).then((info) => {
      const args = info.IsDir ? ["purge", "SSH:" + path] : ["deletefile", "SSH:" + path];
      return run(args, env).then(() => {
        statCache.delete(path);
        sendJson(response, 200, { ok: true, path });
      });
    }).catch((error) => {
      sendJson(response, 404, { error: error.message });
    });
  }

  /** Write text to the host clipboard; the page falls back to this when its own Clipboard API is blocked. */
  function serveClipboard(request, response) {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) request.destroy();
    });
    request.on("end", () => {
      const command = process.platform === "win32"
        ? { file: "clip", args: [] }
        : process.platform === "darwin"
          ? { file: "pbcopy", args: [] }
          : { file: "xclip", args: ["-selection", "clipboard"] };
      const child = spawn(command.file, command.args, {
        windowsHide: true,
        stdio: ["pipe", "ignore", "ignore"],
      });
      child.on("error", (error) => {
        sendJson(response, 500, { error: error.message });
      });
      child.on("close", (code) => {
        if (code === 0) sendJson(response, 200, { ok: true });
        else sendJson(response, 500, { error: "clipboard command exited with " + code });
      });
      child.stdin.end(body);
    });
  }

  /**
   * Stream one uploaded file to `path/name` with `rclone rcat`, so a drag-and-drop
   * never buffers the whole file in this process.
   */
  function serveUpload(request, response, url) {
    if (!config.allowUpload) {
      sendJson(response, 403, { error: "upload is disabled (allowUpload: false)" });
      return;
    }
    const dir = url.searchParams.get("path") || "";
    const name = url.searchParams.get("name") || "";
    if (!dir || !name) {
      sendJson(response, 400, { error: "path and name are required" });
      return;
    }
    if (name.indexOf("/") >= 0 || name.indexOf("\\") >= 0 || name === "." || name === "..") {
      sendJson(response, 400, { error: "invalid file name" });
      return;
    }
    if (!insideRoot(dir)) {
      sendJson(response, 403, { error: "path outside the configured root" });
      return;
    }

    const target = dir.replace(/\/+$/, "") + "/" + name;
    const child = spawn(RCLONE, ["rcat", "SSH:" + target], {
      windowsHide: true,
      stdio: ["pipe", "ignore", "pipe"],
      env: { ...process.env, ...env },
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 4000) stderr = stderr.slice(-4000);
    });
    child.on("error", (error) => {
      sendJson(response, 500, { error: error.message });
    });
    child.on("close", (code) => {
      if (code === 0) {
        statCache.delete(target);
        sendJson(response, 200, { ok: true, path: target });
      } else {
        sendJson(response, 500, { error: (stderr || "rclone rcat failed").trim().slice(0, 400) });
      }
    });
    request.on("aborted", () => {
      try { child.kill(); } catch (error) { /* ignore */ }
    });
    request.pipe(child.stdin);
    child.stdin.on("error", () => { /* client went away */ });
  }

  return http.createServer((request, response) => {
    if (!config.ssh.host) {
      sendJson(response, 503, { error: "ssh is not configured for dsh-file-explorer" });
      return;
    }
    const url = new URL(request.url || "/", "http://127.0.0.1");
    if (url.pathname === "/") {
      serveIndex(response);
      return;
    }
    if (url.pathname === "/api/file") {
      serveFile(request, response, url);
      return;
    }
    if (url.pathname === "/api/upload") {
      if (request.method !== "POST") {
        sendJson(response, 405, { error: "POST only" });
        return;
      }
      serveUpload(request, response, url);
      return;
    }
    if (url.pathname === "/api/mkdir" || url.pathname === "/api/rename" || url.pathname === "/api/move") {
      if (request.method !== "POST") {
        sendJson(response, 405, { error: "POST only" });
        return;
      }
      serveWrite(request, response, url, url.pathname.slice("/api/".length));
      return;
    }
    if (url.pathname === "/api/clipboard") {
      if (request.method !== "POST") {
        sendJson(response, 405, { error: "POST only" });
        return;
      }
      serveClipboard(request, response);
      return;
    }
    if (url.pathname === "/api/delete") {
      if (request.method !== "POST") {
        sendJson(response, 405, { error: "POST only" });
        return;
      }
      serveDelete(request, response, url);
      return;
    }
    if (url.pathname === "/api/list") {
      const path = url.searchParams.get("path") || root;
      if (!insideRoot(path)) {
        sendJson(response, 403, { error: "path outside the configured root" });
        return;
      }
      listDir(path).then((entries) => {
        sendJson(response, 200, { path, root, entries });
      }).catch((error) => {
        sendJson(response, 404, { error: error.message });
      });
      return;
    }
    sendJson(response, 404, { error: "not found" });
  });
}

function existingLocalBridge(port) {
  return new Promise((resolve) => {
    const request = http.get({
      host: "127.0.0.1",
      port,
      path: "/",
      timeout: 900,
      headers: { "user-agent": "dsh-file-explorer" },
    }, (response) => {
      const server = String(response.headers.server || "").toLowerCase();
      response.resume();
      resolve(server.startsWith("rclone"));
    });
    request.on("error", () => resolve(false));
    request.on("timeout", () => {
      request.destroy();
      resolve(false);
    });
  });
}

function stopOne(child) {
  if (!child || child.exitCode !== null || child.killed) return;
  if (process.platform === "win32" && child.pid) {
    execFile("taskkill", ["/PID", String(child.pid), "/T", "/F"], () => {});
    return;
  }
  try {
    child.kill("SIGKILL");
  } catch (error) {
    console.error("[file-explorer] kill failed: " + error.message);
  }
}

function startLocalBridge(source) {
  const args = [
    "serve", "http", ":local:" + source.path,
    "--addr", "127.0.0.1:" + source.httpPort,
    "--read-only",
    "--log-level", "ERROR",
  ];
  try {
    const child = spawn(RCLONE, args, {
      windowsHide: true,
      stdio: "ignore",
      env: process.env,
    });
    child.on("error", (error) => {
      console.error("[file-explorer] cannot start " + source.id + ": " + error.message);
    });
    return child;
  } catch (error) {
    console.error("[file-explorer] spawn failed for " + source.id + ": " + error.message);
    return undefined;
  }
}

/**
 * Start the tree API plus the local directory bridges while this plugin is loaded.
 * @param ctx - Host context providing effect disposal.
 * @param config - `{ treeRoot, treePort, ssh, sources }` from the loader entry.
 */
export async function apply(ctx, config) {
  const resolved = resolveConfig(config);

  const reuse = new Set();
  for (const source of resolved.sources) {
    if (await existingLocalBridge(source.httpPort)) reuse.add(source.id);
  }

  const env = sshEnv(resolved.ssh);
  const state = {
    config: resolved,
    env,
    root: resolved.treeRoot,
    port: resolved.treePort,
  };

  ctx.effect(() => {
    const children = [];
    for (const source of resolved.sources) {
      if (reuse.has(source.id)) continue;
      const child = startLocalBridge(source);
      if (child) children.push(child);
    }

    let tree;
    if (resolved.ssh.host) {
      tree = createTreeServer(state);
      tree.listen(resolved.treePort, "127.0.0.1", () => {
        console.log("[file-explorer] tree server on http://127.0.0.1:" +
          resolved.treePort + "/ (" + resolved.treeRoot + ")");
      });
      tree.on("error", (error) => {
        console.error("[file-explorer] tree server failed: " + error.message);
      });
    }

    return () => {
      for (const child of children) stopOne(child);
      if (tree) {
        try { tree.close(); } catch (error) { /* ignore */ }
      }
    };
  });
}
