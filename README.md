# Tedx Backend

Simple Express backend to accept workshop registrations and forward them to a Google Apps Script endpoint.

Environment

- `APPSCRIPT_URL` - required. The Apps Script exec URL.
- `APPSCRIPT_TOKEN` - optional. Shared secret to include for verification by Apps Script.

Run locally

```bash
cd server
npm install
node index.js
```

Set environment (PowerShell):

```powershell
$env:APPSCRIPT_URL = 'https://script.google.com/macros/s/.../exec'
$env:APPSCRIPT_TOKEN = 'your_secret'
node index.js
```

Deploy

Choose a hosting for Node (Cloud Run, Heroku, Railway, etc.). Ensure `APPSCRIPT_URL` and `APPSCRIPT_TOKEN` are set in the host environment.
