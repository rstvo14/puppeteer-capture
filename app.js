const express = require("express");
const puppeteer = require("puppeteer-core");
const path = require("path");
const Queue = require("promise-queue");
const PDFDocument = require("pdfkit");

const queue = new Queue(1, Infinity);
const app = express();
const PORT = process.env.PORT || 10000;
const chromePath = "/usr/bin/google-chrome-stable";

async function safeGoto(page, url, timeout = 60000) {
  return Promise.race([
    page.goto(url, { waitUntil: "domcontentloaded", timeout }),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("Manual navigation timeout")), timeout)
    ),
  ]);
}

app.get("/capture", (req, res) => {
  queue.add(() => handleCapture(req, res));
});

async function handleCapture(req, res) {
  let browser;
  try {
    const { url, type } = req.query;
    if (!url) return res.status(400).send("Missing 'url' query parameter.");

    const isPDF = type && type.toLowerCase() === "pdf";

    browser = await puppeteer.launch({
      headless: "new",
      timeout: 60000,
      executablePath: chromePath,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
      ],
      protocolTimeout: 60000,
    });

    const page = await browser.newPage();
    await page.setUserAgent(
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/117 Safari/537.36"
    );
    await page.setViewport({ width: 1220, height: 1000 });

    // Navigate
    await safeGoto(page, url);

    // Wait for our container
    await page.waitForSelector("#capture-full", { timeout: 60000 });

    // Wait for images / charts / canvases to appear
    try {
      await page.waitForFunction(() => {
        const c = document.querySelector("#capture-full");
        if (!c) return false;
        // all images loaded?
        const imgs = Array.from(c.querySelectorAll("img"));
        if (imgs.length && !imgs.every(i => i.complete && i.naturalHeight > 0)) {
          return false;
        }
        // any Highcharts?
        if (c.querySelector("svg.highcharts-root")) return true;
        // any Mapbox canvases?
        if (c.querySelectorAll(".mapboxgl-canvas").length) return true;
        return imgs.length > 0; // fallback
      }, { timeout: 60000 });
    } catch (e) {
      console.warn("Timed out waiting for content—proceeding anyway.");
    }

    // **NEW**: if this is a map-snapshot, give Mapbox tiles a bit more time
    if (url.includes("/map-snapshot")) {
      await delay(5000);
    }

    // Grab the element and screenshot
    const elementHandle = await page.$("#capture-full");
    const box = await elementHandle.boundingBox();
    if (!box) throw new Error("Couldn't find bounding box for #capture-full");

    const pngBuffer = await elementHandle.screenshot({ type: "png" });

    if (isPDF) {
      const doc = new PDFDocument({ autoFirstPage: false });
      const buffers = [];
      doc.on("data", buffers.push.bind(buffers));
      doc.on("end", async () => {
        const pdfBuffer = Buffer.concat(buffers);
        await browser.close();
        res.set({
          "Content-Type": "application/pdf",
          "Content-Length": pdfBuffer.length,
        });
        res.send(pdfBuffer);
      });
      doc.addPage({
        size: [Math.ceil(box.width), Math.ceil(box.height)],
      });
      doc.image(pngBuffer, 0, 0, {
        width: Math.ceil(box.width),
        height: Math.ceil(box.height),
      });
      doc.end();
    } else {
      await browser.close();
      res.set({
        "Content-Type": "image/png",
        "Content-Length": pngBuffer.length,
      });
      res.send(pngBuffer);
    }
  } catch (err) {
    console.error("Capture error:", err);
    if (browser) await browser.close();
    res.status(500).send("Error capturing the requested content.");
  }
}

app.listen(PORT, () => {
  console.log(`Puppeteer capture service running on port ${PORT}`);
});