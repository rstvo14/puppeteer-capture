const express = require('express');
const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

app.get('/capture', async (req, res) => {
  try {
    const { url, type } = req.query;
    if (!url) {
      return res.status(400).send("Missing 'url' query parameter.");
    }
    const fileType = type && type.toLowerCase() === 'pdf' ? 'pdf' : 'png';
    const browser = await puppeteer.launch({
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'networkidle2' });
    
    // Remove the cookie banner elements.
    await page.evaluate(() => {
      const infoBanner = document.querySelector('.cookiesjsr-banner--info');
      const actionBanner = document.querySelector('.cookiesjsr-banner--action');
      if (infoBanner) infoBanner.remove();
      if (actionBanner) actionBanner.remove();
    });
    
    await page.waitForSelector('#mapColumns');
    const elementHandle = await page.$('#mapColumns');
    const boundingBox = await elementHandle.boundingBox();
    if (!boundingBox) {
      throw new Error("Failed to get bounding box for #mapColumns. The element might be hidden.");
    }
    let filePath;
    if (fileType === 'png') {
      filePath = path.join(__dirname, 'output.png');
      await elementHandle.screenshot({ path: filePath });
    } else if (fileType === 'pdf') {
      filePath = path.join(__dirname, 'output.pdf');
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
        fs.unlink(filePath, (unlinkErr) => {
          if (unlinkErr) console.error("Failed to remove temporary file:", unlinkErr);
        });
      }
    });
  } catch (error) {
    console.error("Capture error:", error);
    res.status(500).send("Error capturing the requested content.");
  }
});

app.listen(PORT, () => {
  console.log(`Puppeteer capture service listening on port ${PORT}`);
});