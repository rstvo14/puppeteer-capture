const express = require('express');
const puppeteer = require('puppeteer-core');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 10000;

const chromePath = '/usr/bin/google-chrome-stable';

async function safeGoto(page, url, timeout = 60000) {
  return Promise.race([
    page.goto(url, { waitUntil: 'domcontentloaded', timeout }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('Manual navigation timeout')), timeout))
  ]);
}

app.get('/capture', async (req, res) => {
  try {
    const { url, type } = req.query;
    if (!url) {
      return res.status(400).send("Missing 'url' query parameter.");
    }

    const isPDF = type && type.toLowerCase() === 'pdf';
    const timestamp = Date.now();
    const pngPath = path.join(__dirname, `output-${timestamp}.png`);
    const pdfPath = path.join(__dirname, `output-${timestamp}.pdf`);

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

    await page.setUserAgent(
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/117.0.0.0 Safari/537.36'
    );

    await safeGoto(page, url);

    await page.waitForSelector('#mapColumns', { timeout: 30000 });
    await new Promise(resolve => setTimeout(resolve, 4000));

    const elementHandle = await page.$('#mapColumns');
    const boundingBox = await elementHandle.boundingBox();

    if (!boundingBox) {
      throw new Error("Could not determine bounding box for #mapColumns");
    }

    // Always capture PNG first
    await elementHandle.screenshot({ path: pngPath });

    if (isPDF) {
      const pdfPage = await browser.newPage();
      await pdfPage.setContent(`
        <html>
          <body style="margin:0;padding:0;">
            <img src="file://${pngPath}" style="width:100%;height:auto;" />
          </body>
        </html>
      `, { waitUntil: 'load' });

      await pdfPage.pdf({
        path: pdfPath,
        printBackground: true,
        width: `${Math.ceil(boundingBox.width)}px`,
        height: `${Math.ceil(boundingBox.height)}px`
      });

      await browser.close();

      res.sendFile(pdfPath, err => {
        if (err) {
          console.error('Error sending PDF:', err);
          res.status(500).send("Error delivering the PDF file.");
        } else {
          fs.unlink(pngPath, () => {});
          fs.unlink(pdfPath, () => {});
        }
      });

    } else {
      await browser.close();

      res.sendFile(pngPath, err => {
        if (err) {
          console.error('Error sending PNG:', err);
          res.status(500).send("Error delivering the PNG file.");
        } else {
          fs.unlink(pngPath, () => {});
        }
      });
    }

  } catch (error) {
    console.error("Capture error:", error);
    res.status(500).send("Error capturing the requested content.");
  }
});

app.listen(PORT, () => {
  console.log(`Puppeteer capture service running on port ${PORT}`);
});
