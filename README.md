# WebQR Attendance Automation

This is a lightweight Node.js Express server configured to automate the attendance QR process using Puppeteer. It is designed to be fully compatible with Vercel Serverless Hosting.

## Features
- Fetches the initial URL to scan the QR code.
- Extracts the actual Google script target URL embedded inside the QR code image (`quickchart.io`).
- Submits the attendance synchronously for a predefined list of student IDs.
- Detects success and expired messages.
- Automatically re-fetches a new QR code if it encounters an expired message, and retries the *same* student ID.
- Detailed console logging throughout the process.
- Compatible with Vercel Serverless Functions using `@sparticuz/chromium` and `puppeteer-core`.

## Running Locally

1. Install dependencies:
   ```bash
   npm install
   ```

2. Start the local server:
   ```bash
   node index.js
   ```
   *The server will run on port 3000 by default.*

3. Trigger the automation:
   Open your browser and navigate to:
   http://localhost:3000/run-attendance

   The logs will be streamed back in the JSON response as well as printed in your terminal console.

## Deploying to Vercel

1. Push this directory to a GitHub repository.
2. Link the repository to a new Vercel project.
3. Vercel will automatically detect `vercel.json` and use the Node.js runtime.
4. **Important**: Wait for the deployment to finish. Vercel handles the `@sparticuz/chromium` library smoothly. 
5. To run the automation, visit your deployed app's `/run-attendance` endpoint (e.g. `https://your-app-name.vercel.app/run-attendance`).

> **Note on Vercel Timeout Limits**:
> Hobby (Free) tier on Vercel has a function timeout limit of 10 seconds. Pro tier allows up to 60 seconds. The `maxDuration: 60` is set in `vercel.json`, which will work on Pro. On the free tier, processing 4 students synchronously with Puppeteer may take longer than 10 seconds and might result in a timeout error. If this happens, consider deploying on a VPS (like DigitalOcean or Render) or upgrading to Pro.
