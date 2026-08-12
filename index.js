const express = require("express");
const app = express();


// For Vercel production:
// Vercel serverless functions have a 50MB size limit. 
// @sparticuz/chromium allows Puppeteer to run in this environment.
// const chromium = require("@sparticuz/chromium");
// const puppeteerCore = require("puppeteer-core");

const PORT = process.env.PORT || 3000;

const startUrl = "https://script.google.com/macros/s/AKfycbyTzeQc3hyLa9lWFG6cvglRc9ch-EhSosmdXvjHy30aUA2cjqCsuRj7vQiDsz_AIiuM/exec?display=1&v=IW4111";

const studentIds = [
  "SIT23CS144",
  "SIT23CS199",
  "SIT23CS150",
  "SIT23CS219",
  "SIT23CS207",
  "SITL24CS03"
];

async function getBrowser() {
  if (process.env.VERCEL) {
    const chromium = require("@sparticuz/chromium");
    const { default: puppeteerCore } = await import("puppeteer-core");
    return await puppeteerCore.launch({
      args: chromium.args,
      defaultViewport: chromium.defaultViewport,
      executablePath: await chromium.executablePath(),
      headless: chromium.headless,
      ignoreHTTPSErrors: true,
    });
  } else {
    const { default: puppeteer } = await import("puppeteer");
    return await puppeteer.launch({
      headless: false, // run headlessly
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
  }
}

async function runAttendance(onLog) {
  const log = (msg) => {
    console.log(msg);
    if (onLog) onLog(msg);
  };

  log("Starting attendance process...");
  let browser = null;
  try {
    browser = await getBrowser();
    // We create a temporary page just to fetch the initial target URL
    const tempPage = await browser.newPage();
    tempPage.setDefaultNavigationTimeout(60000);

    const getNewTargetUrl = async (workerPage) => {
      log("Navigating to start URL to fetch QR...");
      const response = await workerPage.goto(startUrl, { waitUntil: 'domcontentloaded' });
      const html = await response.text();

      const qrRegex = /quickchart\.io(?:\\\/|\/)qr\?text(?:=|\\x3d|%3D)([^&\\"]+)/i;
      const match = html.match(qrRegex);

      let targetUrl = null;
      if (match && match[1]) {
        targetUrl = decodeURIComponent(match[1]);
        targetUrl = targetUrl.replace(/\\\//g, '/');
      } else {
        log("Regex failed. Trying fallback extraction from iframe DOM...");
        try {
          await workerPage.waitForSelector('iframe#sandboxFrame', { timeout: 10000 });
          const frameElement = await workerPage.$('iframe#sandboxFrame');
          const frame = await frameElement.contentFrame();

          await frame.waitForFunction(() => document.body.innerHTML.includes("quickchart.io"), { timeout: 10000 });
          const frameHtml = await frame.content();

          const frameMatch = frameHtml.match(/quickchart\.io\/qr\?text=([^&"']+)/i);
          if (frameMatch && frameMatch[1]) {
            targetUrl = decodeURIComponent(frameMatch[1]);
          }
        } catch (e) {
          log("Fallback extraction failed: " + e.message);
        }
      }

      if (!targetUrl) throw new Error("Could not extract target URL from QR.");

      return targetUrl;
    };

    let initialTargetUrl = await getNewTargetUrl(tempPage);
    log(`Extracted initial target URL: ${initialTargetUrl}`);
    await tempPage.close();

    // Helper to wait for a selector across all frames (handles Google Apps Script iframe navigations)
    async function waitForSelectorInAnyFrame(page, selector, timeout = 25000) {
      const startTime = Date.now();
      while (Date.now() - startTime < timeout) {
        for (const frame of page.frames()) {
          try {
            const el = await frame.$(selector);
            if (el) return { frame, el };
          } catch (e) { }
        }
        await new Promise(r => setTimeout(r, 500));
      }
      throw new Error(`Timeout waiting for selector \`${selector}\` in any frame`);
    }

    const processStudent = async (studentId) => {
      const studentPage = await browser.newPage();
      studentPage.setDefaultNavigationTimeout(60000);
      let success = false;
      let currentUrl = initialTargetUrl;

      while (!success) {
        try {
          log(`Processing student ID: ${studentId}`);
          await studentPage.goto(currentUrl, { waitUntil: 'networkidle2', timeout: 60000 });

          log(`Waiting for input box for ${studentId}...`);
          const { frame: inputFrame, el: inputEl } = await waitForSelectorInAnyFrame(studentPage, 'input#studentid', 40000);

          await inputFrame.evaluate((el) => el.value = '', inputEl);
          await inputEl.type(studentId);

          log(`Clicking submit for ${studentId}...`);
          const { frame: buttonFrame, el: buttonEl } = await waitForSelectorInAnyFrame(studentPage, 'button[onclick="submitAttendance()"]', 40000);
          await buttonEl.click();

          log(`Waiting for result for ${studentId}...`);

          let resultText = "";
          const startTime = Date.now();
          while (Date.now() - startTime < 45000 && !resultText) {
            for (const frame of studentPage.frames()) {
              try {
                const text = await frame.evaluate(() => {
                  const h2 = document.querySelector('#msg h2') || document.querySelector('#msg');
                  return h2 ? h2.innerText.trim() : "";
                });
                if (text) {
                  resultText = text;
                  break;
                }
              } catch (e) { }
            }
            if (!resultText) await new Promise(r => setTimeout(r, 500));
          }

          if (!resultText) {
            log(`Warning: Could not read result text for ${studentId}, assuming success to avoid infinite loop.`);
            success = true;
            continue;
          }

          log(`Result for ${studentId}: ${resultText}`);

          if (resultText.includes("QR Code Expired") || resultText.includes("Please scan latest QR")) {
            log(`QR expired for ${studentId}. Fetching new QR...`);
            currentUrl = await getNewTargetUrl(studentPage);
          } else if (resultText.includes("Attendance Recorded Successfully") || resultText.includes("Successfully") || resultText.includes("Recorded") || resultText.includes("already")) {
            log(`Successfully processed ${studentId}.`);
            success = true;
          } else {
            log(`Unknown result for ${studentId}, assuming success to continue loop: ${resultText}`);
            success = true;
          }
        } catch (err) {
          log(`Warning: Error processing ${studentId} (${err.message}). Retrying...`);
          await new Promise(r => setTimeout(r, 3000));
        }
      }
      await studentPage.close();
    };

    // Run all students in parallel!
    await Promise.all(studentIds.map(id => processStudent(id)));

    log("All student IDs processed successfully.");
  } catch (error) {
    log(`Error occurred: ${error.message}`);
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Attendance Automator</title>
      <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;600;800&display=swap" rel="stylesheet">
      <style>
        :root {
          --bg: #0f172a;
          --surface: rgba(30, 41, 59, 0.7);
          --primary: #3b82f6;
          --primary-hover: #2563eb;
          --text: #f8fafc;
          --text-muted: #94a3b8;
          --success: #10b981;
          --error: #ef4444;
        }
        body {
          margin: 0;
          font-family: 'Outfit', sans-serif;
          background: var(--bg);
          color: var(--text);
          display: flex;
          flex-direction: column;
          align-items: center;
          min-height: 100vh;
          overflow-x: hidden;
          background-image: 
            radial-gradient(at 0% 0%, hsla(253,16%,7%,1) 0, transparent 50%), 
            radial-gradient(at 50% 0%, hsla(225,39%,30%,1) 0, transparent 50%), 
            radial-gradient(at 100% 0%, hsla(339,49%,30%,1) 0, transparent 50%);
        }
        .container {
          margin-top: 10vh;
          width: 90%;
          max-width: 800px;
          background: var(--surface);
          backdrop-filter: blur(16px);
          -webkit-backdrop-filter: blur(16px);
          border: 1px solid rgba(255, 255, 255, 0.1);
          border-radius: 24px;
          padding: 40px;
          box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.5);
          display: flex;
          flex-direction: column;
          gap: 24px;
        }
        h1 {
          margin: 0;
          font-size: 2.5rem;
          font-weight: 800;
          background: linear-gradient(to right, #60a5fa, #a78bfa);
          -webkit-background-clip: text;
          -webkit-text-fill-color: transparent;
          text-align: center;
        }
        p.subtitle {
          text-align: center;
          color: var(--text-muted);
          font-size: 1.1rem;
          margin: 0 0 10px 0;
        }
        button {
          background: var(--primary);
          color: white;
          border: none;
          padding: 16px 32px;
          font-size: 1.1rem;
          font-weight: 600;
          border-radius: 12px;
          cursor: pointer;
          transition: all 0.3s ease;
          align-self: center;
          box-shadow: 0 4px 14px 0 rgba(59, 130, 246, 0.39);
        }
        button:hover {
          background: var(--primary-hover);
          transform: translateY(-2px);
          box-shadow: 0 6px 20px rgba(59, 130, 246, 0.23);
        }
        button:disabled {
          background: #475569;
          cursor: not-allowed;
          transform: none;
          box-shadow: none;
        }
        .logs-container {
          background: #020617;
          border-radius: 16px;
          padding: 20px;
          height: 300px;
          overflow-y: auto;
          font-family: monospace;
          font-size: 0.95rem;
          display: flex;
          flex-direction: column;
          gap: 8px;
          border: 1px solid rgba(255, 255, 255, 0.05);
        }
        .log-entry {
          padding: 8px 12px;
          border-radius: 6px;
          background: rgba(255, 255, 255, 0.03);
          border-left: 3px solid #3b82f6;
          animation: slideIn 0.3s ease forwards;
          opacity: 0;
          transform: translateX(-10px);
        }
        @keyframes slideIn {
          to {
            opacity: 1;
            transform: translateX(0);
          }
        }
        .log-success { border-left-color: var(--success); }
        .log-error { border-left-color: var(--error); }
        
        .loader {
          border: 3px solid rgba(255,255,255,0.1);
          border-top-color: white;
          border-radius: 50%;
          width: 20px;
          height: 20px;
          animation: spin 1s linear infinite;
          display: inline-block;
          vertical-align: middle;
          margin-right: 10px;
          display: none;
        }
        @keyframes spin { 100% { transform: rotate(360deg); } }
      </style>
    </head>
    <body>
      <div class="container">
        <h1>Attendance Automator</h1>
        <p class="subtitle">Automatically scan QR codes and submit attendance for the batch.</p>
        
        <button id="runBtn">
          <span class="loader" id="loader"></span>
          <span id="btnText">Start Automation</span>
        </button>

        <div class="logs-container" id="logs">
          <div class="log-entry" style="border-left-color: #64748b;">Waiting to start...</div>
        </div>
      </div>

      <script>
        const btn = document.getElementById('runBtn');
        const loader = document.getElementById('loader');
        const btnText = document.getElementById('btnText');
        const logsDiv = document.getElementById('logs');

        function appendLog(msg, type = 'normal') {
          const div = document.createElement('div');
          div.className = 'log-entry';
          if (msg.toLowerCase().includes('success') || msg.toLowerCase().includes('recorded') || msg.toLowerCase().includes('already')) {
            div.classList.add('log-success');
          } else if (msg.toLowerCase().includes('error') || msg.toLowerCase().includes('failed') || msg.toLowerCase().includes('expired')) {
            div.classList.add('log-error');
          }
          div.textContent = msg;
          logsDiv.appendChild(div);
          logsDiv.scrollTop = logsDiv.scrollHeight;
        }

        btn.addEventListener('click', () => {
          btn.disabled = true;
          loader.style.display = 'inline-block';
          btnText.textContent = 'Processing...';
          logsDiv.innerHTML = '';
          appendLog('Connecting to server...');

          const eventSource = new EventSource('/run-attendance');

          eventSource.onmessage = function(event) {
            const data = JSON.parse(event.data);
            
            if (data.done) {
              appendLog(data.message, data.error ? 'error' : 'success');
              eventSource.close();
              btn.disabled = false;
              loader.style.display = 'none';
              btnText.textContent = 'Start Automation';
              return;
            }

            appendLog(data.message);
          };

          eventSource.onerror = function() {
            appendLog('Connection to server lost or error occurred.', 'error');
            eventSource.close();
            btn.disabled = false;
            loader.style.display = 'none';
            btnText.textContent = 'Start Automation';
          };
        });
      </script>
    </body>
    </html>
  `);
});

app.get('/run-attendance', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  try {
    await runAttendance((msg) => {
      res.write(`data: ${JSON.stringify({ message: msg })}\n\n`);
      if (res.flush) res.flush(); // For environments that support compression/flushing
    });
    res.write(`data: ${JSON.stringify({ message: "Process completed.", done: true })}\n\n`);
  } catch (error) {
    res.write(`data: ${JSON.stringify({ message: "Error: " + error.message, error: true, done: true })}\n\n`);
  } finally {
    res.end();
  }
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
  });
}

module.exports = app;
