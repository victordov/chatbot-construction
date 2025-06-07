/**
 * Load Testing Script for Chatbot Application
 *
 * This script simulates high traffic to the chatbot server to measure
 * performance under load and identify bottlenecks.
 *
 * Usage: node load-test.js [users] [duration] [rampUp]
 *   users: Number of concurrent users (default: 100)
 *   duration: Test duration in seconds (default: 60)
 *   rampUp: Ramp-up period in seconds (default: 10)
 */

const autocannon = require('autocannon');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

// Parse command line arguments
const args = process.argv.slice(2);
const users = parseInt(args[0]) || 100;
const duration = parseInt(args[1]) || 60;
const rampUp = parseInt(args[2]) || 10;

// Configuration
const config = {
  url: 'http://localhost:3000',
  socketUrl: 'ws://localhost:3000',
  outputDir: path.join(__dirname, '../load-test-results'),
  scenarios: [
    {
      name: 'chat-api',
      weight: 60, // 60% of requests
      endpoint: '/api/chat',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        message: 'Hello, this is a load test message',
        sessionId: uuidv4()
      })
    },
    {
      name: 'session-api',
      weight: 20, // 20% of requests
      endpoint: '/api/session',
      method: 'GET'
    },
    {
      name: 'index-page',
      weight: 20, // 20% of requests
      endpoint: '/',
      method: 'GET'
    }
  ]
};

// Create output directory if it doesn't exist
if (!fs.existsSync(config.outputDir)) {
  fs.mkdirSync(config.outputDir, { recursive: true });
}

console.log(`Starting load test with ${users} concurrent users for ${duration} seconds...`);
console.log(`Ramp-up period: ${rampUp} seconds`);

// Function to run a single load test scenario
async function runScenario(scenario) {
  console.log(`Running scenario: ${scenario.name}`);

  const instance = autocannon({
    url: `${config.url}${scenario.endpoint}`,
    connections: users,
    duration: duration,
    headers: scenario.headers || {},
    method: scenario.method,
    body: scenario.body,
    setupClient: scenario.setupClient,

    // Ramp-up configuration
    startup: {
      duration: rampUp,
      startRate: 1,
      endRate: users
    },

    // Request rate limiting (optional)
    // maxOverallRequests: users * duration * 10, // max 10 requests per user per second

    // Track latency percentiles
    latency: true,

    // Track status code counts
    statusCodes: true,

    // Print progress to console
    progress: true
  });

  // Save results
  const results = await instance;
  const timestamp = new Date().toISOString().replace(/:/g, '-');
  const outputFile = path.join(
    config.outputDir,
    `load-test-${scenario.name}-${timestamp}.json`
  );

  fs.writeFileSync(
    outputFile,
    JSON.stringify(results, null, 2)
  );

  return results;
}

// Function to run WebSocket load test
async function runWebSocketTest() {
  console.log('Running WebSocket load test...');

  // WebSocket test requires a different approach with socket.io-client
  // Implement based on your WebSocket implementation
  console.log('WebSocket load testing requires manual implementation based on your WebSocket setup');

  // Return placeholder results
  return {
    name: 'websocket',
    timestamp: new Date().toISOString(),
    message: 'WebSocket load test requires manual implementation'
  };
}

// Run all scenarios and collect results
async function runLoadTest() {
  console.log('Starting load test...');

  const startTime = Date.now();
  const results = {};

  // Run API scenarios
  for (const scenario of config.scenarios) {
    results[scenario.name] = await runScenario(scenario);
  }

  // Run WebSocket test
  // results.websocket = await runWebSocketTest();

  // Calculate overall metrics
  const totalRequests = Object.values(results)
    .reduce((sum, result) => sum + (result.requests?.total || 0), 0);

  const totalErrors = Object.values(results)
    .reduce((sum, result) => sum + (result.errors || 0), 0);

  const totalDuration = (Date.now() - startTime) / 1000;

  const averageLatency = Object.values(results)
    .reduce((sum, result) => sum + (result.latency?.average || 0), 0) /
    Object.values(results).length;

  // Generate summary report
  const summary = {
    timestamp: new Date().toISOString(),
    totalUsers: users,
    duration: totalDuration,
    totalRequests,
    requestsPerSecond: totalRequests / totalDuration,
    totalErrors,
    errorRate: totalErrors / totalRequests,
    averageLatency,
    scenarios: Object.keys(results).map(name => ({
      name,
      requests: results[name].requests?.total || 0,
      errors: results[name].errors || 0,
      latency: results[name].latency || {}
    }))
  };

  // Save summary report
  const summaryFile = path.join(
    config.outputDir,
    `load-test-summary-${new Date().toISOString().replace(/:/g, '-')}.json`
  );

  fs.writeFileSync(
    summaryFile,
    JSON.stringify(summary, null, 2)
  );

  console.log('\nLoad test completed!');
  console.log(`Total requests: ${totalRequests}`);
  console.log(`Requests per second: ${(totalRequests / totalDuration).toFixed(2)}`);
  console.log(`Average latency: ${averageLatency.toFixed(2)} ms`);
  console.log(`Error rate: ${(totalErrors / totalRequests * 100).toFixed(2)}%`);
  console.log(`Results saved to: ${config.outputDir}`);

  return summary;
}

runLoadTest().catch(error => {
  console.error('Error during load test:', error);
  process.exit(1);
});
