// The build's own endpoint. Copied verbatim into every build dir by src/behavior.ts, so a cloned form has
// somewhere REAL to submit with no accounts, no external service and no dependencies:
//
//   node server.mjs [port]        # default 3000
//
// It serves the static clone AND accepts POST /api/submit, appending one JSON line per submission to
// submissions.jsonl beside it. Opening index.html straight off disk still works — the injected runtime falls
// back to localStorage on file:// and says so — but only this path is a real submission.
import { createServer } from "node:http";
import { readFile, appendFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.argv[2] || process.env.PORT || 3000);
const LOG = path.join(ROOT, "submissions.jsonl");
const MAX_BODY = 16 * 1024; // a capture form is a few short strings; anything larger is not one

const MIME = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".avif": "image/avif",
  ".gif": "image/gif", ".ico": "image/x-icon", ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf",
  ".otf": "font/otf", ".mp4": "video/mp4", ".webm": "video/webm", ".txt": "text/plain; charset=utf-8",
};

const json = (res, code, obj) => {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body) });
  res.end(body);
};

async function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error("body too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://localhost:${PORT}`);

  if (url.pathname === "/api/submit") {
    if (req.method !== "POST") return json(res, 405, { ok: false, error: "POST only" });
    let payload;
    try {
      payload = JSON.parse(await readBody(req));
    } catch (e) {
      return json(res, 400, { ok: false, error: String(e.message || e) });
    }
    if (!payload || typeof payload !== "object" || typeof payload.fields !== "object" || !payload.fields) {
      return json(res, 400, { ok: false, error: "expected {form, fields}" });
    }
    const row = { ts: new Date().toISOString(), form: String(payload.form ?? ""), fields: payload.fields };
    await appendFile(LOG, JSON.stringify(row) + "\n", "utf8");
    console.log(`  ✓ submission → ${path.basename(LOG)}  ${JSON.stringify(row.fields).slice(0, 120)}`);
    return json(res, 200, { ok: true });
  }

  if (req.method !== "GET" && req.method !== "HEAD") return json(res, 405, { ok: false, error: "GET only" });

  // Static file, resolved and then prefix-checked so no `..` can escape the build directory.
  const rel = decodeURIComponent(url.pathname).replace(/^\/+/, "") || "index.html";
  const file = path.resolve(ROOT, rel.endsWith("/") ? rel + "index.html" : rel);
  if (file !== ROOT && !file.startsWith(ROOT + path.sep)) return json(res, 403, { ok: false, error: "forbidden" });
  // Never serve the submission log or the server itself over HTTP.
  if (file === LOG || file === path.join(ROOT, "server.mjs")) return json(res, 403, { ok: false, error: "forbidden" });

  try {
    const buf = await readFile(file);
    res.writeHead(200, { "content-type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream", "content-length": buf.length });
    res.end(req.method === "HEAD" ? undefined : buf);
  } catch {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("404");
  }
});

server.listen(PORT, () => {
  console.log(`\n  serving ${ROOT}`);
  console.log(`  http://localhost:${PORT}`);
  console.log(`  submissions → ${LOG}\n`);
});
