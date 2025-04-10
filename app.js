const express = require('express');
const puppeteer = require('puppeteer-core');
const path = require('path');
const fs = require('fs');
const Queue = require('promise-queue');
const PDFDocument = require('pdfkit');

const queue = new Queue(1, Infinity);
const app = express();
const PORT = process.env.PORT || 10000;
const chromePath = '/usr/bin/google-chrome-stable';

async function safeGoto(page, url, timeout = 60000) {
  return Promise.race([
    page.goto(url, { waitUntil: 'domcontentloaded', timeout }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('Manual navigation timeout')), timeout))
  ]);
}

app.get('/capture', (req, res) => {
  queue.add(() => handleCapture(req, res));
});

async function handleCapture(req, res) {
  try {
    const { url, type } = req.query;
    if (!url) return res.status(400).send("Missing 'url' query parameter.");

    const isPDF = type && type.toLowerCase() === 'pdf';
    const timestamp = Date.now();
    const pngPath = path.join(__dirname, `output-${timestamp}.png`);

    const browser = await puppeteer.launch({
      headless: 'new',
      executablePath: chromePath,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });

    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/117 Safari/537.36');
    await safeGoto(page, url);

    await page.waitForSelector('#mapColumns', { timeout: 30000 });
    await new Promise(resolve => setTimeout(resolve, 4000));

    const elementHandle = await page.$('#mapColumns');
    const boundingBox = await elementHandle.boundingBox();
    if (!boundingBox) throw new Error("Could not determine bounding box for #mapColumns");

    // Capture PNG to buffer
    const pngBuffer = await elementHandle.screenshot({ type: 'png' });

    if (isPDF) {
      const doc = new PDFDocument({ autoFirstPage: false });
      const buffers = [];

      doc.on('data', buffers.push.bind(buffers));
      doc.on('end', async () => {
        const pdfBuffer = Buffer.concat(buffers);
        await browser.close();

        res.set({
          'Content-Type': 'application/pdf',
          'Content-Length': pdfBuffer.length
        });
        return res.send(pdfBuffer);
      });

      // Match PDF size to image
      const width = Math.ceil(boundingBox.width);
      const height = Math.ceil(boundingBox.height);
      doc.addPage({ size: [width, height] });
      doc.image(pngBuffer, 0, 0, { width, height });
      doc.end();

    } else {
      await browser.close();
      res.set({
        'Content-Type': 'image/png',
        'Content-Length': pngBuffer.length
      });
      return res.send(pngBuffer);
    }

  } catch (error) {
    console.error("Capture error:", error);
    res.status(500).send("Error capturing the requested content.");
  }
}

app.listen(PORT, () => {
  console.log(`Puppeteer capture service running on port ${PORT}`);
});