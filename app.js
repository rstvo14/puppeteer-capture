const express = require('express');
const puppeteer = require('puppeteer-core');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 10000;

// Add this line at the top of your file (after the requires):
const chromePath = '/usr/bin/google-chrome-stable';

app.get('/capture', async (req, res) => {
  try {
    const { url, type } = req.query;
    if (!url) {
      return res.status(400).send("Missing 'url' query parameter.");
    }

    const fileType = type && type.toLowerCase() === 'pdf' ? 'pdf' : 'png';

    const browser = await puppeteer.launch({
      headless: 'new',
      executablePath: chromePath,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage'
      ]
    });

    const page = await browser.newPage();
    await page.goto(url, {
      waitUntil: 'networkidle2',
      timeout: 60000,
    });

    await page.waitForSelector('#mapColumns', { timeout: 30000 });
    await new Promise(resolve => setTimeout(resolve, 4000));

    const elementHandle = await page.$('#mapColumns');
    const boundingBox = await elementHandle.boundingBox();

    if (!boundingBox) {
      throw new Error("Could not determine bounding box for #mapColumns");
    }

    const filePath = path.join(__dirname, fileType === 'pdf' ? 'output.pdf' : 'output.png');

    if (fileType === 'png') {
      await elementHandle.screenshot({ path: filePath });
    } else {
      await page.pdf({
        path: filePath,
        printBackground: true,
        width: `${Math.ceil(boundingBox.width)}px`,
        height: `${Math.ceil(boundingBox.height)}px`
      });
    }

    await browser.close();

    res.sendFile(filePath, err => {
      if (err) {
        console.error('Error sending file:', err);
        res.status(500).send("Error delivering the captured file.");
      } else {
        fs.unlink(filePath, err => {
          if (err) console.error("Failed to delete file:", err);
        });
      }
    });

  } catch (error) {
    console.error("Capture error:", error);
    res.status(500).send("Error capturing the requested content.");
  }
});

app.listen(PORT, () => {
  console.log(`Puppeteer capture service running on port ${PORT}`);
});