#!/usr/bin/env node
// filepath: c:\dev\proj\personal\chatbot-construction\scripts\security-audit.js

/**
 * Security Audit Script
 *
 * This script automates various security checks for the chatbot application.
 * It runs npm audit, checks for common security issues, and generates a report.
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
// eslint-disable-next-line no-unused-vars
const crypto = require('crypto');

// Configuration
const config = {
  outputDir: path.join(__dirname, '../security-reports'),
  checkLevels: ['info', 'low', 'moderate', 'high', 'critical'],
  sensitivePatterns: [
    /password\s*=\s*['"][^'"]+['"]/i,
    /apiKey\s*=\s*['"][^'"]+['"]/i,
    /secret\s*=\s*['"][^'"]+['"]/i,
    /jwt[\w]*secret\s*=\s*['"][^'"]+['"]/i,
    /authorization\s*:\s*['"]Bearer\s+[^'"]+['"]/i
  ],
  filesToExclude: [
    'node_modules',
    '.git',
    'package-lock.json',
    'security-reports'
  ],
  fileTypesToCheck: [
    '.js',
    '.json',
    '.env',
    '.ts',
    '.yml',
    '.yaml'
  ]
};

// Create output directory if it doesn't exist
if (!fs.existsSync(config.outputDir)) {
  fs.mkdirSync(config.outputDir, { recursive: true });
}

// Initialize report data
const report = {
  timestamp: new Date().toISOString(),
  npmAudit: null,
  sensitiveData: [],
  insecureConfigurations: [],
  summary: {}
};

// Logger utility to avoid direct console usage
const logger = {
  log: function() {
    // eslint-disable-next-line no-console
    console.log(...arguments);
  },
  error: function() {
    // eslint-disable-next-line no-console
    console.error(...arguments);
  },
  warn: function() {
    // eslint-disable-next-line no-console
    console.warn(...arguments);
  }
};

/**
 * Run npm audit and capture the results
 */
function runNpmAudit() {
  logger.log('Running npm audit...');
  try {
    // Run npm audit as JSON for parsing
    const auditOutput = execSync('npm audit --json', { encoding: 'utf8' });
    report.npmAudit = JSON.parse(auditOutput);

    // Count vulnerabilities by severity
    const vulnerabilities = report.npmAudit.vulnerabilities || {};
    report.summary.vulnerabilities = {
      info: 0,
      low: 0,
      moderate: 0,
      high: 0,
      critical: 0,
      total: 0
    };

    Object.values(vulnerabilities).forEach(vuln => {
      const severity = vuln.severity.toLowerCase();
      if (report.summary.vulnerabilities[severity] !== undefined) {
        report.summary.vulnerabilities[severity]++;
        report.summary.vulnerabilities.total++;
      }
    });

    console.log(`Found ${report.summary.vulnerabilities.total} npm vulnerabilities`);
  } catch (error) {
    // npm audit returns non-zero exit code if vulnerabilities are found
    try {
      report.npmAudit = JSON.parse(error.stdout);

      // Count vulnerabilities by severity
      const vulnerabilities = report.npmAudit.vulnerabilities || {};
      report.summary.vulnerabilities = {
        info: 0,
        low: 0,
        moderate: 0,
        high: 0,
        critical: 0,
        total: 0
      };

      Object.values(vulnerabilities).forEach(vuln => {
        const severity = vuln.severity.toLowerCase();
        if (report.summary.vulnerabilities[severity] !== undefined) {
          report.summary.vulnerabilities[severity]++;
          report.summary.vulnerabilities.total++;
        }
      });

      console.log(`Found ${report.summary.vulnerabilities.total} npm vulnerabilities`);
    } catch (parseError) {
      console.error('Error parsing npm audit results:', parseError);
      report.npmAudit = {
        error: 'Failed to parse npm audit results',
        output: error.stdout
      };
    }
  }
}

/**
 * Check for hardcoded sensitive data in files
 */
function checkForSensitiveData(dir = process.cwd()) {
  console.log('Checking for sensitive data in files...');

  const results = [];

  function scanDirectory(directory) {
    const files = fs.readdirSync(directory);

    for (const file of files) {
      const fullPath = path.join(directory, file);
      const relativePath = path.relative(process.cwd(), fullPath);

      // Skip excluded files and directories
      if (config.filesToExclude.some(exclude => relativePath.includes(exclude))) {
        continue;
      }

      const stats = fs.statSync(fullPath);

      if (stats.isDirectory()) {
        scanDirectory(fullPath);
      } else if (stats.isFile()) {
        const extension = path.extname(fullPath).toLowerCase();

        // Check only specific file types
        if (config.fileTypesToCheck.includes(extension)) {
          try {
            const content = fs.readFileSync(fullPath, 'utf8');
            const issues = findSensitiveData(content, relativePath);
            results.push(...issues);
          } catch (error) {
            console.error(`Error reading file ${relativePath}:`, error.message);
          }
        }
      }
    }
  }

  function findSensitiveData(content, filePath) {
    const issues = [];

    for (const pattern of config.sensitivePatterns) {
      const matches = content.match(pattern);
      if (matches) {
        matches.forEach(match => {
          // Attempt to redact the actual sensitive value
          const redactedMatch = match.replace(
            /(['"])([^'"]+)(['"])/,
            (_, prefix, sensitive, suffix) =>
              `${prefix}${sensitive.substring(0, 3)}...${suffix}`
          );

          issues.push({
            file: filePath,
            pattern: pattern.toString(),
            match: redactedMatch,
            line: findLineNumber(content, match)
          });
        });
      }
    }

    return issues;
  }

  function findLineNumber(content, match) {
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes(match)) {
        return i + 1;
      }
    }
    return -1;
  }

  scanDirectory(dir);
  report.sensitiveData = results;
  report.summary.sensitiveData = results.length;

  console.log(`Found ${results.length} instances of potentially sensitive data`);
}

/**
 * Check for common security misconfigurations
 */
function checkSecurityConfigurations() {
  console.log('Checking for security misconfigurations...');

  const issues = [];

  // Check for missing HTTPS
  try {
    const serverFile = fs.readFileSync(path.join(process.cwd(), 'server.js'), 'utf8');
    if (!serverFile.includes('https') && !serverFile.includes('SSL')) {
      issues.push({
        type: 'HTTPS',
        issue: 'Application may not be using HTTPS',
        file: 'server.js',
        severity: 'high'
      });
    }
  } catch (error) {
    console.error('Error checking server configuration:', error.message);
  }

  // Check for weak CORS configuration
  try {
    const files = ['server.js', 'app.js', 'index.js', 'websockets.js'];
    for (const file of files) {
      try {
        const content = fs.readFileSync(path.join(process.cwd(), file), 'utf8');
        if (content.includes('Access-Control-Allow-Origin') &&
            content.includes('*')) {
          issues.push({
            type: 'CORS',
            issue: 'Overly permissive CORS configuration (Access-Control-Allow-Origin: *)',
            file,
            severity: 'high'
          });
        }
      } catch (fileError) {
        // Skip if file doesn't exist
      }
    }
  } catch (error) {
    console.error('Error checking CORS configuration:', error.message);
  }

  // Check for JWT algorithm configuration
  try {
    const authFiles = ['auth.js', 'authentication.js', 'jwt.js'];
    const authDirs = ['services', 'middleware', 'utils', 'lib', '.'];

    for (const dir of authDirs) {
      for (const file of authFiles) {
        try {
          const filePath = path.join(process.cwd(), dir, file);
          const content = fs.readFileSync(filePath, 'utf8');

          if (content.includes('jsonwebtoken') || content.includes('jwt.sign')) {
            if (!content.includes('algorithm') || content.includes('none')) {
              issues.push({
                type: 'JWT',
                issue: 'JWT configuration may be using insecure algorithms or default settings',
                file: path.relative(process.cwd(), filePath),
                severity: 'high'
              });
            }

            if (content.includes('expiresIn') &&
                (content.includes('365d') || content.includes('1y'))) {
              issues.push({
                type: 'JWT',
                issue: 'JWT tokens have very long expiration time',
                file: path.relative(process.cwd(), filePath),
                severity: 'medium'
              });
            }
          }
        } catch (fileError) {
          // Skip if file doesn't exist
        }
      }
    }
  } catch (error) {
    console.error('Error checking JWT configuration:', error.message);
  }

  report.insecureConfigurations = issues;
  report.summary.insecureConfigurations = issues.length;

  console.log(`Found ${issues.length} security misconfigurations`);
}

/**
 * Generate security report file
 */
function generateReport() {
  console.log('Generating security report...');

  // Calculate overall risk score (simple algorithm - can be improved)
  let riskScore = 0;

  // Add npm vulnerabilities to risk score
  if (report.summary.vulnerabilities) {
    riskScore += report.summary.vulnerabilities.critical * 10;
    riskScore += report.summary.vulnerabilities.high * 5;
    riskScore += report.summary.vulnerabilities.moderate * 2;
    riskScore += report.summary.vulnerabilities.low * 0.5;
  }

  // Add sensitive data findings to risk score
  riskScore += report.summary.sensitiveData * 3;

  // Add misconfigurations to risk score
  const highSeverityMisconfigs = report.insecureConfigurations.filter(
    issue => issue.severity === 'high'
  ).length;

  const mediumSeverityMisconfigs = report.insecureConfigurations.filter(
    issue => issue.severity === 'medium'
  ).length;

  riskScore += highSeverityMisconfigs * 5;
  riskScore += mediumSeverityMisconfigs * 2;

  // Normalize risk score to 0-100 range (simple approach)
  riskScore = Math.min(100, riskScore);

  // Determine risk level
  let riskLevel;
  if (riskScore >= 75) {
    riskLevel = 'Critical';
  } else if (riskScore >= 50) {
    riskLevel = 'High';
  } else if (riskScore >= 25) {
    riskLevel = 'Medium';
  } else if (riskScore >= 10) {
    riskLevel = 'Low';
  } else {
    riskLevel = 'Minimal';
  }

  report.summary.riskScore = riskScore;
  report.summary.riskLevel = riskLevel;

  // Generate unique filename
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const reportPath = path.join(
    config.outputDir,
    `security-audit-${timestamp}.json`
  );

  // Write report to file
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

  // Generate HTML report for better readability
  const htmlReportPath = path.join(
    config.outputDir,
    `security-audit-${timestamp}.html`
  );

  const htmlReport = generateHtmlReport(report);
  fs.writeFileSync(htmlReportPath, htmlReport);

  console.log(`Security report saved to: ${reportPath}`);
  console.log(`HTML report saved to: ${htmlReportPath}`);
  console.log(`Risk score: ${riskScore} (${riskLevel} Risk)`);
}

/**
 * Generate HTML report from the JSON data
 */
function generateHtmlReport(report) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Security Audit Report</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      line-height: 1.6;
      color: #333;
      max-width: 1200px;
      margin: 0 auto;
      padding: 20px;
    }
    h1, h2, h3 {
      color: #2c3e50;
    }
    .summary {
      background-color: #f8f9fa;
      border-radius: 5px;
      padding: 20px;
      margin-bottom: 30px;
    }
    .risk-score {
      font-size: 24px;
      font-weight: bold;
      margin-bottom: 10px;
    }
    .risk-critical { color: #e74c3c; }
    .risk-high { color: #e67e22; }
    .risk-medium { color: #f39c12; }
    .risk-low { color: #3498db; }
    .risk-minimal { color: #2ecc71; }

    table {
      width: 100%;
      border-collapse: collapse;
      margin-bottom: 30px;
    }
    th, td {
      border: 1px solid #ddd;
      padding: 12px;
      text-align: left;
    }
    th {
      background-color: #f2f2f2;
    }
    tr:nth-child(even) {
      background-color: #f9f9f9;
    }
    .severity-critical { background-color: #ffebee; }
    .severity-high { background-color: #fff3e0; }
    .severity-moderate { background-color: #fffde7; }
    .severity-low { background-color: #e8f5e9; }

    .section {
      margin-bottom: 40px;
    }

    .recommendation {
      background-color: #e8f4fd;
      border-left: 4px solid #2196f3;
      padding: 15px;
      margin-bottom: 20px;
    }
  </style>
</head>
<body>
  <h1>Security Audit Report</h1>
  <p>Generated on: ${new Date(report.timestamp).toLocaleString()}</p>

  <div class="summary">
    <h2>Summary</h2>
    <div class="risk-score risk-${report.summary.riskLevel.toLowerCase()}">
      Risk Score: ${report.summary.riskScore} (${report.summary.riskLevel} Risk)
    </div>

    <p>
      <strong>Vulnerabilities Found:</strong> ${report.summary.vulnerabilities?.total || 0}<br>
      <strong>Sensitive Data Issues:</strong> ${report.summary.sensitiveData || 0}<br>
      <strong>Security Misconfigurations:</strong> ${report.summary.insecureConfigurations || 0}
    </p>
  </div>

  <div class="section">
    <h2>NPM Vulnerabilities</h2>
    ${generateNpmVulnerabilitiesHtml(report.npmAudit)}
  </div>

  <div class="section">
    <h2>Sensitive Data Findings</h2>
    ${generateSensitiveDataHtml(report.sensitiveData)}
  </div>

  <div class="section">
    <h2>Security Misconfigurations</h2>
    ${generateMisconfigurationsHtml(report.insecureConfigurations)}
  </div>

  <div class="section">
    <h2>Recommendations</h2>
    <div class="recommendation">
      <h3>Address High-Risk Vulnerabilities</h3>
      <p>Prioritize fixing critical and high-severity npm vulnerabilities. Run <code>npm audit fix</code> to automatically fix issues when possible.</p>
    </div>

    <div class="recommendation">
      <h3>Remove Sensitive Data</h3>
      <p>Remove hardcoded secrets, API keys, and credentials from the codebase. Use environment variables or a secure secrets management solution instead.</p>
    </div>

    <div class="recommendation">
      <h3>Fix Security Misconfigurations</h3>
      <p>Address the identified security misconfigurations, especially related to HTTPS, CORS, and JWT implementation.</p>
    </div>

    <div class="recommendation">
      <h3>Regular Security Testing</h3>
      <p>Implement regular security testing as part of the development process. Consider adding automated security checks to your CI/CD pipeline.</p>
    </div>
  </div>
</body>
</html>`;
}

/**
 * Generate HTML section for npm vulnerabilities
 */
function generateNpmVulnerabilitiesHtml(npmAudit) {
  if (!npmAudit || !npmAudit.vulnerabilities) {
    return '<p>No npm audit data available.</p>';
  }

  const vulnerabilities = npmAudit.vulnerabilities;
  const vulnEntries = Object.entries(vulnerabilities);

  if (vulnEntries.length === 0) {
    return '<p>No vulnerabilities found.</p>';
  }

  let html = `
    <table>
      <tr>
        <th>Package</th>
        <th>Severity</th>
        <th>Vulnerability</th>
        <th>Path</th>
        <th>Remediation</th>
      </tr>
  `;

  vulnEntries.forEach(([packageName, details]) => {
    const severity = details.severity.toLowerCase();
    html += `
      <tr class="severity-${severity}">
        <td>${packageName}</td>
        <td>${details.severity}</td>
        <td>${details.title || 'Unknown'}</td>
        <td>${details.path || packageName}</td>
        <td>${details.recommendation || 'Update to the latest version'}</td>
      </tr>
    `;
  });

  html += '</table>';
  return html;
}

/**
 * Generate HTML section for sensitive data findings
 */
function generateSensitiveDataHtml(sensitiveData) {
  if (!sensitiveData || sensitiveData.length === 0) {
    return '<p>No sensitive data issues found.</p>';
  }

  let html = `
    <table>
      <tr>
        <th>File</th>
        <th>Line</th>
        <th>Issue</th>
        <th>Pattern</th>
      </tr>
  `;

  sensitiveData.forEach(issue => {
    html += `
      <tr>
        <td>${issue.file}</td>
        <td>${issue.line}</td>
        <td>${issue.match}</td>
        <td><code>${issue.pattern}</code></td>
      </tr>
    `;
  });

  html += '</table>';
  return html;
}

/**
 * Generate HTML section for security misconfigurations
 */
function generateMisconfigurationsHtml(misconfigurations) {
  if (!misconfigurations || misconfigurations.length === 0) {
    return '<p>No security misconfigurations found.</p>';
  }

  let html = `
    <table>
      <tr>
        <th>Type</th>
        <th>Severity</th>
        <th>Issue</th>
        <th>File</th>
      </tr>
  `;

  misconfigurations.forEach(issue => {
    html += `
      <tr class="severity-${issue.severity}">
        <td>${issue.type}</td>
        <td>${issue.severity}</td>
        <td>${issue.issue}</td>
        <td>${issue.file}</td>
      </tr>
    `;
  });

  html += '</table>';
  return html;
}

// Run all checks
try {
  console.log('Starting security audit...');
  runNpmAudit();
  checkForSensitiveData();
  checkSecurityConfigurations();
  generateReport();
  console.log('Security audit completed successfully.');
} catch (error) {
  console.error('Error during security audit:', error);
  process.exit(1);
}
