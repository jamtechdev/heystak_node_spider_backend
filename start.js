#!/usr/bin/env node

/**
 * Start both API server and Worker in one command
 * Usage: node start.js
 */

import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

console.log('='.repeat(50));
console.log('Starting Spider Backend Services...');
console.log('='.repeat(50));
console.log();
console.log('FastAPI Server: http://localhost:8000');
console.log('API Docs: http://localhost:8000/docs');
console.log();
console.log('Press Ctrl+C to stop both services');
console.log();

// Start API server
const apiProcess = spawn('node', ['src/index.js'], {
  cwd: __dirname,
  stdio: 'inherit',
  shell: true,
});

// Start worker
const workerProcess = spawn('node', ['src/worker.js'], {
  cwd: __dirname,
  stdio: 'inherit',
  shell: true,
});

// Handle cleanup
function cleanup() {
  console.log('\n\nStopping services...');
  apiProcess.kill();
  workerProcess.kill();
  setTimeout(() => {
    console.log('Services stopped.');
    process.exit(0);
  }, 2000);
}

process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);

// Handle process errors
apiProcess.on('error', (error) => {
  console.error(`[API] Error: ${error.message}`);
});

workerProcess.on('error', (error) => {
  console.error(`[Worker] Error: ${error.message}`);
});

apiProcess.on('exit', (code) => {
  if (code !== null && code !== 0) {
    console.error(`[API] Process exited with code ${code}`);
    cleanup();
  }
});

workerProcess.on('exit', (code) => {
  if (code !== null && code !== 0) {
    console.error(`[Worker] Process exited with code ${code}`);
    cleanup();
  }
});
