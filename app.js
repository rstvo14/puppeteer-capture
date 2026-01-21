const express = require("express");
const puppeteer = require("puppeteer-core");
const Queue = require("promise-queue");
const PDFDocument = require("pdfkit");

const queue = new Queue(1, Infinity);
const app = express();
const PORT = process.env.PORT || 10000;

// Chrome installed from Dockerfile:
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
    headless: "new",
    timeout: 180000,
    executablePath: chromePath,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--no-first-run",
      "--use-gl=angle",
      "--use-gl=swiftshader",
      "--hide-scrollbars",
      "--mute-audio"
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

    // Log browser console to server logs for debugging
    page.on("console", (msg) => console.log("BROWSER LOG:", msg.text()));
    page.on("pageerror", (err) => console.error("BROWSER ERROR:", err.message));

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
      await delay(4000);
    }

    // Determine content type to wait for
    const mapSel = "#capture-full .mapboxgl-canvas";
    const chartSel = "#capture-full svg.highcharts-root";
    const imgSel = "#capture-full img";

    if (await page.$(mapSel)) {
      await page.waitForFunction(
        (sel) => {
          const c = document.querySelector(sel);
          return c && c.width > 0 && c.height > 0;
        },
        { timeout: 30000 },
        mapSel
      );
      await delay(6000);
    } else if (await page.$(chartSel)) {
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