const express = require("express");
const puppeteer = require("puppeteer-core");
const path = require("path");
const fs = require("fs");
const Queue = require("promise-queue");
const PDFDocument = require("pdfkit");

const queue = new Queue(1, Infinity);
const app = express();
const PORT = process.env.PORT || 10000;
const chromePath = "/usr/bin/google-chrome-stable";

// race page.goto against a manual timeout
async function safeGoto(page, url, timeout = 60000) {
  return Promise.race([
    page.goto(url, { waitUntil: "domcontentloaded", timeout }),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("Manual navigation timeout")), timeout)
    ),
  ]);
}

// small helper
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
    await page.setViewport({ width: 1220, height: 1000, deviceScaleFactor: 2 });

    // 1) navigate and wait for the capture container
    await safeGoto(page, url);
    await page.waitForSelector("#capture-full", { timeout: 30000 });

    // selectors scoped to #capture-full
    const mapSel   = "#capture-full .mapboxgl-canvas";
    const chartSel = "#capture-full svg.highcharts-root";
    const imgSel   = "#capture-full img";

    // 2) if it's a map page, wait for canvas + 3 s buffer
    if (await page.$(mapSel)) {
      await page.waitForFunction(
        sel => {
          const c = document.querySelector(sel);
          return c && c.width > 0 && c.height > 0;
        },
        { timeout: 30000 },
        mapSel
      );
      await delay(3000);
    }
    // 3) else if it's a chart page, wait for the SVG to render
    else if (await page.$(chartSel)) {
      await page.waitForFunction(
        sel => {
          const svg = document.querySelector(sel);
          return svg && svg.clientWidth > 0 && svg.clientHeight > 0;
        },
        { timeout: 30000 },
        chartSel
      );
    }
    // 4) else if it has images, wait for them to finish loading
    else if ((await page.$$(imgSel)).length > 0) {
      await page.waitForFunction(
        sel => Array.from(document.querySelectorAll(sel))
                      .every(i => i.complete && i.naturalHeight > 0),
        { timeout: 30000 },
        imgSel
      );
    }
    // otherwise we proceed immediately

    // 5) screenshot
    const elementHandle = await page.$("#capture-full");
    const box = await elementHandle.boundingBox();
    if (!box) throw new Error("Could not determine bounding box");

    const pngBuffer = await elementHandle.screenshot({ type: "png" });

    // 6) send back PDF or PNG
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
      doc.addPage({ size: [Math.ceil(box.width), Math.ceil(box.height)] });
      doc.image(pngBuffer, 0, 0, { width: box.width, height: box.height });
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