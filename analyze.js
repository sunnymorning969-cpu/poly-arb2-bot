const fs = require('fs');

// 读取 CSV 文件
const csvPath = 'C:\\Users\\PC\\PycharmProjects\\PythonProject\\trades.csv';
const content = fs.readFileSync(csvPath, 'utf-8');
const lines = content.trim().split('\n');

const output = [];
const log = (msg) => {
  output.push(msg);
};

log(`总交易数: ${lines.length - 1}`);

// 解析数据
const trades = [];

for (let i = 1; i < lines.length; i++) {
  const parts = lines[i].split(',');
  if (parts.length >= 9) {
    trades.push({
      time: parts[0],
      direction: parts[1],
      result: parts[2],
      quantity: parseFloat(parts[3]) || 0,
      price: parseFloat(parts[4]) || 0,
      amount: parseFloat(parts[5]) || 0,
      slug: parts[8],
    });
  }
}

// 按 slug 分组分析
const bySlug = new Map();

for (const trade of trades) {
  if (!bySlug.has(trade.slug)) {
    bySlug.set(trade.slug, { up: [], down: [] });
  }
  const group = bySlug.get(trade.slug);
  if (trade.result === 'Up') {
    group.up.push(trade);
  } else if (trade.result === 'Down') {
    group.down.push(trade);
  }
}

log(`不同事件数: ${bySlug.size}`);

// 分析每个事件的组合成本
const eventStats = [];

for (const [slug, group] of bySlug) {
  const upShares = group.up.reduce((sum, t) => sum + t.quantity, 0);
  const upCost = group.up.reduce((sum, t) => sum + t.amount, 0);
  const downShares = group.down.reduce((sum, t) => sum + t.quantity, 0);
  const downCost = group.down.reduce((sum, t) => sum + t.amount, 0);
  
  const upAvgPrice = upShares > 0 ? upCost / upShares : 0;
  const downAvgPrice = downShares > 0 ? downCost / downShares : 0;
  const combinedCost = upAvgPrice + downAvgPrice;
  
  const pairedShares = Math.min(upShares, downShares);
  const totalCost = upCost + downCost;
  const profit = pairedShares - totalCost * (pairedShares / Math.max(upShares, downShares, 1));
  
  const is15min = slug.includes('15m');
  const isBtc = slug.includes('btc') || slug.includes('bitcoin');
  
  if (upShares > 0 && downShares > 0) {
    eventStats.push({
      slug,
      upShares,
      upCost,
      upAvgPrice,
      downShares,
      downCost,
      downAvgPrice,
      combinedCost,
      profit,
      is15min,
      isBtc,
    });
  }
}

log(`\n有对冲的事件数: ${eventStats.length}`);

// 分析组合成本分布
log('\n========== 组合成本分布 ==========');
const costRanges = [
  { min: 0, max: 0.90, count: 0 },
  { min: 0.90, max: 0.95, count: 0 },
  { min: 0.95, max: 0.98, count: 0 },
  { min: 0.98, max: 1.00, count: 0 },
  { min: 1.00, max: 1.05, count: 0 },
  { min: 1.05, max: 2.00, count: 0 },
];

for (const event of eventStats) {
  for (const range of costRanges) {
    if (event.combinedCost >= range.min && event.combinedCost < range.max) {
      range.count++;
      break;
    }
  }
}

for (const range of costRanges) {
  const pct = ((range.count / eventStats.length) * 100).toFixed(1);
  log(`$${range.min.toFixed(2)}-$${range.max.toFixed(2)}: ${range.count} 个事件 (${pct}%)`);
}

// 分析价格分布
log('\n========== Up 价格分布 ==========');
const upPrices = trades.filter(t => t.result === 'Up').map(t => t.price);
const priceRanges = [
  { min: 0, max: 0.10, count: 0 },
  { min: 0.10, max: 0.20, count: 0 },
  { min: 0.20, max: 0.30, count: 0 },
  { min: 0.30, max: 0.50, count: 0 },
  { min: 0.50, max: 0.70, count: 0 },
  { min: 0.70, max: 0.90, count: 0 },
  { min: 0.90, max: 1.00, count: 0 },
];

for (const price of upPrices) {
  for (const range of priceRanges) {
    if (price >= range.min && price < range.max) {
      range.count++;
      break;
    }
  }
}

for (const range of priceRanges) {
  const pct = ((range.count / upPrices.length) * 100).toFixed(1);
  log(`$${range.min.toFixed(2)}-$${range.max.toFixed(2)}: ${range.count} 笔 (${pct}%)`);
}

log('\n========== Down 价格分布 ==========');
const downPrices = trades.filter(t => t.result === 'Down').map(t => t.price);
const downRanges = [
  { min: 0, max: 0.10, count: 0 },
  { min: 0.10, max: 0.20, count: 0 },
  { min: 0.20, max: 0.30, count: 0 },
  { min: 0.30, max: 0.50, count: 0 },
  { min: 0.50, max: 0.70, count: 0 },
  { min: 0.70, max: 0.90, count: 0 },
  { min: 0.90, max: 1.00, count: 0 },
];

for (const price of downPrices) {
  for (const range of downRanges) {
    if (price >= range.min && price < range.max) {
      range.count++;
      break;
    }
  }
}

for (const range of downRanges) {
  const pct = ((range.count / downPrices.length) * 100).toFixed(1);
  log(`$${range.min.toFixed(2)}-$${range.max.toFixed(2)}: ${range.count} 笔 (${pct}%)`);
}

// 利润最高的事件
log('\n========== 利润最高的 10 个事件 ==========');
eventStats.sort((a, b) => b.profit - a.profit);
for (let i = 0; i < Math.min(10, eventStats.length); i++) {
  const e = eventStats[i];
  const type = e.is15min ? '15min' : '1hr';
  const asset = e.isBtc ? 'BTC' : 'ETH';
  log(`${asset} ${type}: Up ${e.upShares.toFixed(0)} @ $${e.upAvgPrice.toFixed(3)} + Down ${e.downShares.toFixed(0)} @ $${e.downAvgPrice.toFixed(3)} = $${e.combinedCost.toFixed(4)} | 利润: $${e.profit.toFixed(2)}`);
}

// 亏损最多的事件
log('\n========== 亏损最多的 10 个事件 ==========');
eventStats.sort((a, b) => a.profit - b.profit);
for (let i = 0; i < Math.min(10, eventStats.length); i++) {
  const e = eventStats[i];
  const type = e.is15min ? '15min' : '1hr';
  const asset = e.isBtc ? 'BTC' : 'ETH';
  log(`${asset} ${type}: Up ${e.upShares.toFixed(0)} @ $${e.upAvgPrice.toFixed(3)} + Down ${e.downShares.toFixed(0)} @ $${e.downAvgPrice.toFixed(3)} = $${e.combinedCost.toFixed(4)} | 利润: $${e.profit.toFixed(2)}`);
}

// 总体统计
log('\n========== 总体统计 ==========');
const totalProfit = eventStats.reduce((sum, e) => sum + e.profit, 0);
const avgCombinedCost = eventStats.reduce((sum, e) => sum + e.combinedCost, 0) / eventStats.length;
const profitableEvents = eventStats.filter(e => e.profit > 0).length;
const winRate = (profitableEvents / eventStats.length) * 100;

log(`总利润: $${totalProfit.toFixed(2)}`);
log(`平均组合成本: $${avgCombinedCost.toFixed(4)}`);
log(`盈利事件: ${profitableEvents}/${eventStats.length} (${winRate.toFixed(1)}%)`);

// 15分钟 vs 1小时
const events15m = eventStats.filter(e => e.is15min);
const events1h = eventStats.filter(e => !e.is15min);

if (events15m.length > 0) {
  log(`\n15分钟事件: ${events15m.length} 个, 平均成本: $${(events15m.reduce((s, e) => s + e.combinedCost, 0) / events15m.length).toFixed(4)}`);
}
if (events1h.length > 0) {
  log(`1小时事件: ${events1h.length} 个, 平均成本: $${(events1h.reduce((s, e) => s + e.combinedCost, 0) / events1h.length).toFixed(4)}`);
}

// BTC vs ETH
const eventsBtc = eventStats.filter(e => e.isBtc);
const eventsEth = eventStats.filter(e => !e.isBtc);

if (eventsBtc.length > 0) {
  log(`\nBTC 事件: ${eventsBtc.length} 个, 平均成本: $${(eventsBtc.reduce((s, e) => s + e.combinedCost, 0) / eventsBtc.length).toFixed(4)}`);
}
if (eventsEth.length > 0) {
  log(`ETH 事件: ${eventsEth.length} 个, 平均成本: $${(eventsEth.reduce((s, e) => s + e.combinedCost, 0) / eventsEth.length).toFixed(4)}`);
}

// 写入结果文件
fs.writeFileSync('c:\\Users\\PC\\Desktop\\poly-arb2-bot\\analysis-result.txt', output.join('\n'), 'utf-8');

