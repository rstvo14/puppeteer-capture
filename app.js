const express = require("express");
const puppeteer = require("puppeteer-core");
const Queue = require("promise-queue");
const PDFDocument = require("pdfkit");
const Redis = require("ioredis");

const queue = new Queue(1, Infinity);
const app = express();
const PORT = process.env.PORT || 10000;

// ------------------------------------------------------
// PERSISTENT STATS (REDIS)
// ------------------------------------------------------
const redisUrl = process.env.REDIS_URL ||
  (process.env.REDISHOST ? `redis://${process.env.REDISUSER || 'default'}:${process.env.REDISPASSWORD}@${process.env.REDISHOST}:${process.env.REDISPORT}` : null);

if (!redisUrl) {
  console.warn("⚠️ REDIS_URL not found. Stats will NOT be saved to Redis. Please check Railway Variables.");
} else {
  console.log(`✅ Attempting Redis connection: ${redisUrl.replace(/:[^:@]+@/, ":****@")}`);
}

const redis = redisUrl ? new Redis(redisUrl, {
  maxRetriesPerRequest: 1,
  connectTimeout: 5000,
  retryStrategy(times) {
    return times <= 3 ? 1000 : null; // Only retry 3 times then give up to stop log spam
  }
}) : null;

if (redis) {
  redis.on("error", (err) => {
    if (err.code === "ECONNREFUSED") {
      // Don't log ECONNREFUSED spam
    } else {
      console.error("Redis connection error:", err.message);
    }
  });
}

async function trackStat(field) {
  if (!redis || redis.status !== "ready") return;
  try {
    await redis.hincrby("capture_stats", field, 1);
    await redis.hincrby("capture_stats", "total", 1);
  } catch (err) { /* Silent fail */ }
}

// ------------------------------------------------------
// STATS ENDPOINT
// ------------------------------------------------------
app.get("/stats", async (req, res) => {
  try {
    const data = await redis.hgetall("capture_stats");
    res.json({
      uptime_info: "Stats are now persistent in Redis.",
      current_counts: {
        total: parseInt(data.total || 0),
        pdf: parseInt(data.pdf || 0),
        png: parseInt(data.png || 0),
        maps: parseInt(data.maps || 0),
        charts: parseInt(data.charts || 0),
        images: parseInt(data.images || 0),
        errors: parseInt(data.errors || 0)
      },
      service_info: "Visit /capture?url=... to generate an image or PDF."
    });
  } catch (err) {
    res.status(500).json({ error: "Could not fetch stats" });
  }
});
const chromePath = "/usr/bin/google-chrome-stable";

// ------------------------------------------------------
// SHARED BROWSER INSTANCE
// ------------------------------------------------------
let sharedBrowser = null;

async function getBrowser() {
  if (sharedBrowser && sharedBrowser.isConnected()) {
    try {
      // Basic health check to ensure the browser is still responsive
      await sharedBrowser.version();
      return sharedBrowser;
    } catch (err) {
      console.error("Shared browser unresponsive, closing and restarting...", err);
      await sharedBrowser.close().catch(() => { });
      sharedBrowser = null;
    }
  }

  sharedBrowser = await puppeteer.launch({
    headless: "shell",
    timeout: 180000,
    ignoreHTTPSErrors: true,
    executablePath: chromePath,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--no-first-run",
      "--use-gl=angle",
      "--use-angle=swiftshader",
      "--enable-unsafe-swiftshader",
      "--use-vulkan=off",
      "--ignore-gpu-blocklist",
      "--ignore-certificate-errors",
      "--disable-web-security",
      "--disable-gpu-sandbox",
      "--test-type",
      "--hide-scrollbars",
      "--mute-audio",
      "--disable-background-networking",
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "--disable-breakpad",
      "--disable-client-side-phishing-detection",
      "--disable-default-apps",
      "--disable-extensions",
      "--disable-hang-monitor",
      "--disable-ipc-flooding-protection",
      "--disable-render-backgrounding",
      "--disable-sync"
    ],
    protocolTimeout: 180000,
  });

  return sharedBrowser;
}

// ------------------------------------------------------
// SAFE GOTO (handles manual timeout)
// ------------------------------------------------------
async function safeGoto(page, url, timeout = 120000) {
  return Promise.race([
    page.goto(url, { waitUntil: "domcontentloaded", timeout }),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("Manual navigation timeout")), timeout)
    )
  ]);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ------------------------------------------------------
// ROUTE
// ------------------------------------------------------
app.get("/capture", (req, res) => {
  queue.add(() => handleCapture(req, res));
});

// ------------------------------------------------------
// MAIN CAPTURE HANDLER
// ------------------------------------------------------
async function handleCapture(req, res) {
  let page = null;

  try {
    const { url, type } = req.query;
    if (!url) {
      return res.status(400).send("Missing 'url' query parameter.");
    }

    const isPDF = type && type.toLowerCase() === "pdf";

    // Get shared browser
    const browser = await getBrowser();
    page = await browser.newPage();

    // Log browser console only if needed for debugging (currently off for cleaner logs)
    // page.on("console", (msg) => console.log("BROWSER LOG:", msg.text()));
    // page.on("pageerror", (err) => console.error("BROWSER ERROR:", err.message));

    await page.setUserAgent(
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/117 Safari/537.36"
    );

    await page.setViewport({
      width: 1220,
      height: 1000,
      deviceScaleFactor: 2
    });

    // Load page
    await safeGoto(page, url);

    // Core container
    await page.waitForSelector("#capture-full", { timeout: 30000 });

    // Optional "snapshot-ready" indicator
    try {
      await page.waitForSelector("#snapshot-ready", { timeout: 20000 });
    } catch {
      await delay(2000);
    }

    // Determine content type to wait for
    const mapSel = "#capture-full .mapboxgl-canvas";
    const chartSel = "#capture-full svg.highcharts-root";
    const imgSel = "#capture-full img";
    let identifiedCategory = "Image";

    if (await page.$(mapSel)) {
      identifiedCategory = "Map";
      await page.waitForFunction(
        (sel) => {
          const c = document.querySelector(sel);
          return c && c.width > 0 && c.height > 0;
        },
        { timeout: 30000 },
        mapSel
      );
      await delay(3000);
    } else if (await page.$(chartSel)) {
      identifiedCategory = "Chart";
      await page.waitForFunction(
        (sel) => {
          const svg = document.querySelector(sel);
          return svg && svg.clientWidth > 0 && svg.clientHeight > 0;
        },
        { timeout: 30000 },
        chartSel
      );
    } else if ((await page.$$(imgSel)).length > 0) {
      await page.waitForFunction(
        (sel) =>
          Array.from(document.querySelectorAll(sel)).every(
            (i) => i.complete && i.naturalHeight > 0
          ),
        { timeout: 30000 },
        imgSel
      );
    }

    const element = await page.$("#capture-full");
    const box = await element.boundingBox();
    if (!box) throw new Error("Could not determine element bounding box.");

    const pngBuffer = await element.screenshot({ type: "png" });

    // Update persistent stats in Redis
    trackStat(isPDF ? "pdf" : "png");
    trackStat(identifiedCategory.toLowerCase() + "s"); // maps, charts, or images

    console.log(`[SUCCESS] Category: ${identifiedCategory} | Format: ${isPDF ? "PDF" : "PNG"} | URL: ${url}`);

    // ------------------------------------------------------
    // PDF OUTPUT
    // ------------------------------------------------------
    if (isPDF) {
      const doc = new PDFDocument({ autoFirstPage: false });
      const buffers = [];

      doc.on("data", buffers.push.bind(buffers));
      doc.on("end", () => {
        const pdfBuffer = Buffer.concat(buffers);
        res.set({
          "Content-Type": "application/pdf",
          "Content-Length": pdfBuffer.length
        });
        res.send(pdfBuffer);
      });

      doc.addPage({
        size: [Math.ceil(box.width), Math.ceil(box.height)]
      });

      doc.image(pngBuffer, 0, 0, {
        width: box.width,
        height: box.height
      });

      doc.end();
      return;
    }

    // ------------------------------------------------------
    // PNG OUTPUT
    // ------------------------------------------------------
    res.set({
      "Content-Type": "image/png",
      "Content-Length": pngBuffer.length
    });
    res.send(pngBuffer);

  } catch (err) {
    trackStat("errors");
    console.error("Capture error:", err);
    if (err.message && err.message.includes("Failed to launch the browser")) {
      console.error("Critical Chrome failure – forcing container restart");
      process.exit(1);
    }
    // Reset shared browser if it crashed
    if (sharedBrowser && !sharedBrowser.isConnected()) {
      sharedBrowser = null;
    }

    res.status(500).send("Error capturing the requested content.");
  } finally {
    if (page) {
      await page.close().catch((e) =>
        console.error("Error closing page:", e)
      );
    }
  }
}

// ------------------------------------------------------
// SERVER
// ------------------------------------------------------
app.listen(PORT, () => {
  console.log(`Puppeteer capture service running on port ${PORT}`);
});