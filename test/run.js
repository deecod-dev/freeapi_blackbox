const fs = require('fs');
const path = require('path');
require('dotenv').config();

// We must require the router singleton
const blackBox = require('../src/index.js');

// Helper to format duration
function formatTime(ms) {
  return `${(ms / 1000).toFixed(2)}s`;
}

async function startTest() {
  const questionsPath = path.join(__dirname, 'questions.json');
  if (!fs.existsSync(questionsPath)) {
    console.error('questions.json not found! Run generate_questions.js first.');
    process.exit(1);
  }

  const questions = JSON.parse(fs.readFileSync(questionsPath, 'utf8'));
  
  // Get limit and concurrency from command line arguments or environment
  const limit = Math.min(
    questions.length,
    parseInt(process.argv.find(arg => arg.startsWith('--limit='))?.split('=')[1] || process.env.TEST_LIMIT || '300', 10)
  );
  
  const concurrency = parseInt(
    process.argv.find(arg => arg.startsWith('--concurrency='))?.split('=')[1] || process.env.TEST_CONCURRENCY || '5',
    10
  );

  const testQuestions = questions.slice(0, limit);

  console.log('====================================================');
  console.log('             BLACKBOX ROUTER STRESS TEST            ');
  console.log('====================================================');
  console.log(`Total questions to run: ${limit}`);
  console.log(`Concurrency limit:     ${concurrency}`);
  console.log(`Dashboard server is running at: http://localhost:3737`);
  console.log('====================================================\n');

  // Track stats
  const results = [];
  const providerStats = {};
  let successCount = 0;
  let failCount = 0;
  const startTime = Date.now();

  let activeRequests = 0;
  let index = 0;

  // Worker loop
  async function worker() {
    while (index < limit) {
      const qIndex = index++;
      const question = testQuestions[qIndex];
      activeRequests++;
      
      const reqStart = Date.now();
      let success = false;
      let errorMsg = null;
      let responseText = '';
      let assignedProvider = 'unknown';

      // We hook into BlackBox stats/logs to determine which provider was chosen.
      // Since generateContent is atomic, we can find the bucket whose activeRequests went up,
      // or we can look at the console output or the stats change.
      // But a more robust way is to log before and after, or temporarily patch the router console log.
      // Let's get the active providers before and after or patch generateContent.
      // Wait, let's keep it simple: we can look at which provider has an incremented `requestsDone` or `activeRequests`.
      // Or, since BlackBox is running asynchronously, we can look at the state of buckets.
      // Better yet, we can intercept or inspect the provider name by tracking the delta of requestsDone.
      const snapshotBefore = blackBox.buckets.map(b => ({ id: b.config.id, done: b.requestsDone, failed: b.requestsFailed }));

      try {
        responseText = await blackBox.generateContent(question, false);
        success = true;
        successCount++;
      } catch (err) {
        errorMsg = err.message;
        failCount++;
      }

      const reqDuration = Date.now() - reqStart;
      activeRequests--;

      // Detect which provider handled the request by comparing done/failed counts
      const snapshotAfter = blackBox.buckets.map(b => ({ id: b.config.id, done: b.requestsDone, failed: b.requestsFailed }));
      for (let i = 0; i < blackBox.buckets.length; i++) {
        const before = snapshotBefore[i];
        const after = snapshotAfter[i];
        if (before && after && (after.done > before.done || after.failed > before.failed)) {
          assignedProvider = after.id;
          break;
        }
      }

      // Record provider stats
      if (!providerStats[assignedProvider]) {
        providerStats[assignedProvider] = { total: 0, success: 0, failure: 0, latencies: [] };
      }
      providerStats[assignedProvider].total++;
      if (success) {
        providerStats[assignedProvider].success++;
      } else {
        providerStats[assignedProvider].failure++;
      }
      providerStats[assignedProvider].latencies.push(reqDuration);

      // Log progress
      const progress = `${qIndex + 1}/${limit}`;
      const preview = responseText ? responseText.replace(/\n/g, ' ').substring(0, 50) + '...' : `Error: ${errorMsg}`;
      const statusColor = success ? '\x1b[32mSUCCESS\x1b[0m' : '\x1b[31mFAILED\x1b[0m';
      
      console.log(
        `[${progress}] [${statusColor}] [${assignedProvider}] [${formatTime(reqDuration)}] Q: "${question}" -> "${preview}"`
      );

      results.push({
        index: qIndex,
        question,
        success,
        provider: assignedProvider,
        durationMs: reqDuration,
        response: responseText,
        error: errorMsg
      });
    }
  }

  // Spawn initial batch of workers
  const workers = [];
  for (let i = 0; i < Math.min(concurrency, limit); i++) {
    workers.push(worker());
  }

  // Wait for all workers to finish
  await Promise.all(workers);

  const totalDuration = Date.now() - startTime;

  console.log('\n====================================================');
  console.log('                 STRESS TEST SUMMARY                ');
  console.log('====================================================');
  console.log(`Total Time Elapsed:   ${formatTime(totalDuration)}`);
  console.log(`Successful Requests:  ${successCount} (${((successCount / limit) * 100).toFixed(1)}%)`);
  console.log(`Failed Requests:      ${failCount} (${((failCount / limit) * 100).toFixed(1)}%)`);
  console.log(`Average Latency:      ${formatTime(results.reduce((acc, r) => acc + r.durationMs, 0) / limit)}`);
  console.log('====================================================\n');

  // Print provider table
  console.log('Provider Usage Breakdown:');
  const tableData = Object.keys(providerStats).map(providerId => {
    const stats = providerStats[providerId];
    const avgLatency = stats.latencies.reduce((a, b) => a + b, 0) / stats.latencies.length;
    return {
      'Provider ID': providerId,
      'Routed Req': stats.total,
      'Succeeded': stats.success,
      'Failed': stats.failure,
      'Success %': `${((stats.success / stats.total) * 100).toFixed(1)}%`,
      'Avg Latency': formatTime(avgLatency)
    };
  });
  console.table(tableData);

  // Write report
  const reportPath = path.join(__dirname, 'test_report.json');
  fs.writeFileSync(reportPath, JSON.stringify({
    timestamp: new Date().toISOString(),
    totalDurationMs: totalDuration,
    totalQuestions: limit,
    concurrency,
    successCount,
    failCount,
    providerStats,
    results
  }, null, 2));
  console.log(`\nDetailed test report saved to: ${reportPath}`);

  // Exit cleanly
  console.log('\nShutting down. Stress test completed successfully.');
  process.exit(0);
}

// Handle unhandled rejections
process.on('unhandledRejection', (err) => {
  console.error('Unhandled Promise Rejection during test:', err);
});

startTest();
