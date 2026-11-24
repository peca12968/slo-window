import { createServer } from "node:http";
import { once } from "node:events";
import { gzipSync } from "node:zlib";
import { chromium } from "playwright";
import { compare } from "./compare.mjs";

const pixel = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+xmAAAAABJRU5ErkJggg==", "base64");

export async function captureDemo() {
  const log = [];
  const payload = Buffer.from("delivery scan\n".repeat(4000));
  const compressed = gzipSync(payload);
  const asset = createServer((req, res) => {
    if (!["/foreign.png", "/shared.png"].includes(req.url)) return res.writeHead(404).end();
    log.push({ path: req.url, status: 200, bodyBytes: pixel.length });
    res.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "no-store",
      ...(req.url === "/shared.png" ? { "Timing-Allow-Origin": "*" } : {}),
      "Access-Control-Allow-Origin": "*" }).end(pixel);
  });
  const app = createServer((req, res) => {
    if (req.url === "/") return res.writeHead(200, { "Content-Type": "text/html" }).end("<title>Resource timing fixture</title>");
    if (!["/manifest", "/payload"].includes(req.url)) return res.writeHead(404).end();
    if (req.url === "/manifest") {
      const status = req.headers["if-none-match"] === '"v1"' ? 304 : 200;
      const body = status === 200 ? Buffer.from("current route") : Buffer.alloc(0);
      log.push({ path: req.url, status, bodyBytes: body.length });
      return res.writeHead(status, { ETag: '"v1"', "Cache-Control": "no-cache" }).end(body);
    }
    log.push({ path: req.url, status: 200, bodyBytes: compressed.length });
    res.writeHead(200, { "Content-Encoding": "gzip", "Cache-Control": "public, max-age=3600",
      "Content-Length": compressed.length }).end(compressed);
  });
  const browser = await chromium.launch();
  try {
    const listen = async server => {
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      return "http://127.0.0.1:" + server.address().port;
    };
    const [origin, foreign] = await Promise.all([listen(app), listen(asset)]);
    const context = await browser.newContext();
    async function run() {
      const page = await context.newPage();
      page.setDefaultTimeout(6000);
      await page.goto(origin);
      const start = log.length;
      await page.evaluate(async foreign => {
        performance.clearResourceTimings();
        for (const path of ["/manifest", "/payload"]) await (await fetch(path)).arrayBuffer();
        for (const path of ["/foreign.png", "/shared.png"]) await (await fetch(foreign + path)).arrayBuffer();
      }, foreign);
      try {
        await page.waitForFunction(() => ["/manifest", "/payload", "/foreign.png", "/shared.png"].every(
          path => performance.getEntriesByType("resource").some(e => new URL(e.name).pathname === path)));
      } catch (error) {
        const entries = await page.evaluate(() => performance.getEntries().map(e => [e.entryType, e.name]));
        throw new Error(JSON.stringify({ entries, requests: log.slice(start) }), { cause: error });
      }
      const snapshot = await page.evaluate(() => ({ page: location.href, resources: performance.getEntriesByType("resource")
        .filter(e => ["/manifest", "/payload", "/foreign.png", "/shared.png"].includes(new URL(e.name).pathname)).map(e => e.toJSON()) }));
      await page.close();
      return { snapshot, requests: log.slice(start) };
    }
    const cold = await run();
    const warm = await run();
    return { cold, warm, report: compare(cold.snapshot, warm.snapshot) };
  } finally {
    await browser.close();
    await Promise.all([app, asset].filter(s => s.listening).map(s => new Promise(resolve => s.close(resolve))));
  }
}

if (import.meta.main) {
  const { cold, warm, report } = await captureDemo();
  console.log(JSON.stringify({ requests: { cold: cold.requests, warm: warm.requests }, report }, null, 2));
}
