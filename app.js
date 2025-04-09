// app.js
const express = require('express');
const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// Endpoint to capture the DIV content as PNG or PDF.
app.get('/capture', async (req, res) => {
  try {
    const { url, type } = req.query;
    if (!url) {
      return res.status(400).send("Missing 'url' query parameter.");
    }
    const fileType = type && type.toLowerCase() === 'pdf' ? 'pdf' : 'png';

    // Launch Puppeteer.
    // The --no-sandbox and --disable-setuid-sandbox flags help in restrictive hosting environments.
    const browser = await puppeteer.launch({
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    const page = await browser.newPage();

    // Navigate to the provided URL. Wait until network activity subsides.
    await page.goto(url, { waitUntil: 'networkidle2' });

    // Wait for the specific DIV element to be rendered.
    await page.waitForSelector('#mapColumns');

    // Get the element handle for #mapColumns.
    const elementHandle = await page.$('#mapColumns');

    // Determine the bounding box for the element.
    const boundingBox = await elementHandle.boundingBox();
    if (!boundingBox) {
      throw new Error("Failed to get bounding box for #mapColumns. The element might be hidden.");
    }

    // Define a temporary file path.
    let filePath;
    if (fileType === 'png') {
      filePath = path.join(__dirname, 'output.png');
      await elementHandle.screenshot({ path: filePath });
    } else if (fileType === 'pdf') {
      filePath = path.join(__dirname, 'output.pdf');
      // For PDF output, set the page size to match the element’s bounding box.
      await page.pdf({
        path: filePath,
        printBackground: true,
        width: `${Math.ceil(boundingBox.width)}px`,
        height: `${Math.ceil(boundingBox.height)}px`
      });
    }

    await browser.close();

    // Serve the generated file.
    res.sendFile(filePath, err => {
      if (err) {
        console.error('Error sending file:', err);
        res.status(500).send("Error delivering the captured file.");
      } else {
        // Optionally, remove the file after it’s sent.
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

// Start the server.
app.listen(PORT, () => {
  console.log(`Puppeteer capture service listening on port ${PORT}`);
});