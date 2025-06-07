/* eslint-env node */

const path = require('path');
const fs = require('fs');
const express = require('express');
const app = express();

// Create a public directory for serving static files
const publicDir = path.join(__dirname, 'public');
if (!fs.existsSync(publicDir)) {
  fs.mkdirSync(publicDir);
}

// Serve static files
app.use(express.static(publicDir));
