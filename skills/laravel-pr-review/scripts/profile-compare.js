"use strict";

const LOWER_IS_BETTER_ROUTE = [
  "requestP95Ms", "dbTimeP95Ms", "dbWaitP95Ms", "responseBytesP95", "cpuP95Ms", "memoryBytesP95",
];
const LOWER_IS_BETTER_QUEUE = ["waitP95Ms", "durationP95Ms", "retryRate"];
const LOWER_IS_BETTER_CACHE = ["operationWaitP95Ms", "evictionsPerMinuteP95"];
const LOWER_IS_BETTER_RUNTIME = ["workerMemoryBytesP95", "workerBusyRatioP95", "dbConnectionUtilizationP95"];

function percentChange(before, after) {
  if (before === 0) return after === 0 ? 0 : null;
  return Number((((after - before) / Math.abs(before)) * 100).toFixed(2));
}

function addComparison(results, scope, metric, before, after, lowerIsBetter) {
  if (before === undefined || after === undefined) return;
  const changePercent = percentChange(before, after);
  const regression = lowerIsBetter ? after > before : after < before;
  results.push({ scope, metric, baseline: before, current: after, changePercent, regression });
}

function compareProfiles(baseline, current) {
  const results = [];
  const baselineRoutes = new Map(baseline.routes.map((item) => [item.template, item]));
  const currentRoutes = new Map(current.routes.map((item) => [item.template, item]));
  const newRoutes = [...currentRoutes.keys()].filter((key) => !baselineRoutes.has(key)).sort();
  const removedRoutes = [...baselineRoutes.keys()].filter((key) => !currentRoutes.has(key)).sort();

  for (const [template, before] of baselineRoutes) {
    const after = currentRoutes.get(template);
    if (!after) continue;
    for (const metric of LOWER_IS_BETTER_ROUTE) addComparison(results, `route ${template}`, metric, before[metric], after[metric], true);
    const beforeQueries = new Map((before.queryPatterns || []).map((item) => [item.hash, item]));
    const afterQueries = new Map((after.queryPatterns || []).map((item) => [item.hash, item]));
    for (const [hash, query] of beforeQueries) {
      const currentQuery = afterQueries.get(hash);
      if (!currentQuery) continue;
      addComparison(results, `route ${template} query ${hash}`, "callsPerRequestP95", query.callsPerRequestP95, currentQuery.callsPerRequestP95, true);
      addComparison(results, `route ${template} query ${hash}`, "timeP95Ms", query.timeP95Ms, currentQuery.timeP95Ms, true);
    }
  }

  const beforeQueues = new Map(baseline.queues.map((item) => [item.name, item]));
  const afterQueues = new Map(current.queues.map((item) => [item.name, item]));
  const newQueues = [...afterQueues.keys()].filter((key) => !beforeQueues.has(key)).sort();
  const removedQueues = [...beforeQueues.keys()].filter((key) => !afterQueues.has(key)).sort();
  for (const [name, before] of beforeQueues) {
    const after = afterQueues.get(name);
    if (!after) continue;
    for (const metric of LOWER_IS_BETTER_QUEUE) addComparison(results, `queue ${name}`, metric, before[metric], after[metric], true);
  }

  if (baseline.cache && current.cache && baseline.cache.driver === current.cache.driver) {
    for (const metric of LOWER_IS_BETTER_CACHE) addComparison(results, `cache ${current.cache.driver}`, metric, baseline.cache[metric], current.cache[metric], true);
    addComparison(results, `cache ${current.cache.driver}`, "hitRate", baseline.cache.hitRate, current.cache.hitRate, false);
  }
  if (baseline.runtime && current.runtime && baseline.runtime.pool === current.runtime.pool) {
    for (const metric of LOWER_IS_BETTER_RUNTIME) addComparison(results, `runtime ${current.runtime.pool}`, metric, baseline.runtime[metric], current.runtime[metric], true);
  }

  results.sort((left, right) => {
    if (left.regression !== right.regression) return left.regression ? -1 : 1;
    const leftPercent = left.changePercent === null ? Number.POSITIVE_INFINITY : Math.abs(left.changePercent);
    const rightPercent = right.changePercent === null ? Number.POSITIVE_INFINITY : Math.abs(right.changePercent);
    return rightPercent - leftPercent || left.scope.localeCompare(right.scope) || left.metric.localeCompare(right.metric);
  });
  return {
    baselineEnvironment: baseline.environment,
    currentEnvironment: current.environment,
    comparedMetricCount: results.length,
    regressionCount: results.filter((item) => item.regression).length,
    newRoutes,
    removedRoutes,
    newQueues,
    removedQueues,
    metrics: results,
  };
}

function exceedsRegressionGate(comparison, thresholdPercent) {
  if (thresholdPercent === undefined) return false;
  if (comparison.comparedMetricCount === 0) return true;
  return comparison.metrics.some((item) => item.regression &&
    (item.changePercent === null || item.changePercent >= thresholdPercent));
}

module.exports = { compareProfiles, exceedsRegressionGate };
