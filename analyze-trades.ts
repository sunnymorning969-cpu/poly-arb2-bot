import * as fs from 'fs';

// 输出到文件
const output: string[] = [];
const log = (msg: string) => {
  output.push(msg);
  console.log(msg);
};

// 读取 CSV 文件
const csvPath = 'C:\\Users\\PC\\PycharmProjects\\PythonProject\\trades.csv';
const content = fs.readFileSync(csvPath, 'utf-8');
const lines = content.trim().split('\n');

// 解析数据
interface Trade {
  time: string;
  direction: string;
  result: string; // Up 或 Down
  quantity: number;
  price: number;
  amount: number;
  title: string;
  conditionId: string;
  slug: string;
}

const trades: Trade[] = [];

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
      title: parts[6],
      conditionId: parts[7],
      slug: parts[8],
    });
  }
}

console.log(`总交易数: ${trades.length}`);

// 按 slug 分组分析
const bySlug: Map<string, { up: Trade[]; down: Trade[] }> = new Map();

for (const trade of trades) {
  if (!bySlug.has(trade.slug)) {
    bySlug.set(trade.slug, { up: [], down: [] });
  }
  const group = bySlug.get(trade.slug)!;
  if (trade.result === 'Up') {
    group.up.push(trade);
  } else if (trade.result === 'Down') {
    group.down.push(trade);
  }
}

console.log(`\n不同事件数: ${bySlug.size}`);

// 分析每个事件的组合成本
interface EventStats {
  slug: string;
  upShares: number;
  upCost: number;
  upAvgPrice: number;
  downShares: number;
  downCost: number;
  downAvgPrice: number;
  combinedCost: number;
  profit: number;
  is15min: boolean;
  isBtc: boolean;
}

const eventStats: EventStats[] = [];

for (const [slug, group] of bySlug) {
  const upShares = group.up.reduce((sum, t) => sum + t.quantity, 0);
  const upCost = group.up.reduce((sum, t) => sum + t.amount, 0);
  const downShares = group.down.reduce((sum, t) => sum + t.quantity, 0);
  const downCost = group.down.reduce((sum, t) => sum + t.amount, 0);
  
  const upAvgPrice = upShares > 0 ? upCost / upShares : 0;
  const downAvgPrice = downShares > 0 ? downCost / downShares : 0;
  const combinedCost = upAvgPrice + downAvgPrice;
  
  // 计算利润（假设配对部分获得 $1）
  const pairedShares = Math.min(upShares, downShares);
  const profit = pairedShares - (upCost + downCost) * (pairedShares / Math.max(upShares, downShares, 1));
  
  const is15min = slug.includes('15m');
  const isBtc = slug.includes('btc') || slug.includes('bitcoin');
  
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

// 过滤有效的对冲事件（同时有 Up 和 Down）
const hedgedEvents = eventStats.filter(e => e.upShares > 0 && e.downShares > 0);
console.log(`\n有对冲的事件数: ${hedgedEvents.length}`);

// 分析组合成本分布
console.log('\n========== 组合成本分布 ==========');
const costRanges = [
  { min: 0, max: 0.90, count: 0, events: [] as EventStats[] },
  { min: 0.90, max: 0.95, count: 0, events: [] as EventStats[] },
  { min: 0.95, max: 0.98, count: 0, events: [] as EventStats[] },
  { min: 0.98, max: 1.00, count: 0, events: [] as EventStats[] },
  { min: 1.00, max: 1.05, count: 0, events: [] as EventStats[] },
  { min: 1.05, max: 2.00, count: 0, events: [] as EventStats[] },
];

for (const event of hedgedEvents) {
  for (const range of costRanges) {
    if (event.combinedCost >= range.min && event.combinedCost < range.max) {
      range.count++;
      range.events.push(event);
      break;
    }
  }
}

for (const range of costRanges) {
  const pct = ((range.count / hedgedEvents.length) * 100).toFixed(1);
  console.log(`$${range.min.toFixed(2)}-$${range.max.toFixed(2)}: ${range.count} 个事件 (${pct}%)`);
}

// 分析价格分布
console.log('\n========== Up 价格分布 ==========');
const upPrices = trades.filter(t => t.result === 'Up').map(t => t.price);
const upPriceRanges = [
  { min: 0, max: 0.10, count: 0 },
  { min: 0.10, max: 0.20, count: 0 },
  { min: 0.20, max: 0.30, count: 0 },
  { min: 0.30, max: 0.50, count: 0 },
  { min: 0.50, max: 0.70, count: 0 },
  { min: 0.70, max: 0.90, count: 0 },
  { min: 0.90, max: 1.00, count: 0 },
];

for (const price of upPrices) {
  for (const range of upPriceRanges) {
    if (price >= range.min && price < range.max) {
      range.count++;
      break;
    }
  }
}

for (const range of upPriceRanges) {
  const pct = ((range.count / upPrices.length) * 100).toFixed(1);
  console.log(`$${range.min.toFixed(2)}-$${range.max.toFixed(2)}: ${range.count} 笔 (${pct}%)`);
}

console.log('\n========== Down 价格分布 ==========');
const downPrices = trades.filter(t => t.result === 'Down').map(t => t.price);
const downPriceRanges = [
  { min: 0, max: 0.10, count: 0 },
  { min: 0.10, max: 0.20, count: 0 },
  { min: 0.20, max: 0.30, count: 0 },
  { min: 0.30, max: 0.50, count: 0 },
  { min: 0.50, max: 0.70, count: 0 },
  { min: 0.70, max: 0.90, count: 0 },
  { min: 0.90, max: 1.00, count: 0 },
];

for (const price of downPrices) {
  for (const range of downPriceRanges) {
    if (price >= range.min && price < range.max) {
      range.count++;
      break;
    }
  }
}

for (const range of downPriceRanges) {
  const pct = ((range.count / downPrices.length) * 100).toFixed(1);
  console.log(`$${range.min.toFixed(2)}-$${range.max.toFixed(2)}: ${range.count} 笔 (${pct}%)`);
}

// 分析最佳事件（利润最高）
console.log('\n========== 利润最高的 10 个事件 ==========');
hedgedEvents.sort((a, b) => b.profit - a.profit);
for (let i = 0; i < Math.min(10, hedgedEvents.length); i++) {
  const e = hedgedEvents[i];
  const type = e.is15min ? '15min' : '1hr';
  const asset = e.isBtc ? 'BTC' : 'ETH';
  console.log(`${asset} ${type}: Up ${e.upShares.toFixed(0)} @ $${e.upAvgPrice.toFixed(3)} + Down ${e.downShares.toFixed(0)} @ $${e.downAvgPrice.toFixed(3)} = $${e.combinedCost.toFixed(4)} | 利润: $${e.profit.toFixed(2)}`);
}

// 分析亏损事件
console.log('\n========== 亏损最多的 10 个事件 ==========');
hedgedEvents.sort((a, b) => a.profit - b.profit);
for (let i = 0; i < Math.min(10, hedgedEvents.length); i++) {
  const e = hedgedEvents[i];
  const type = e.is15min ? '15min' : '1hr';
  const asset = e.isBtc ? 'BTC' : 'ETH';
  console.log(`${asset} ${type}: Up ${e.upShares.toFixed(0)} @ $${e.upAvgPrice.toFixed(3)} + Down ${e.downShares.toFixed(0)} @ $${e.downAvgPrice.toFixed(3)} = $${e.combinedCost.toFixed(4)} | 利润: $${e.profit.toFixed(2)}`);
}

// 总体统计
console.log('\n========== 总体统计 ==========');
const totalProfit = hedgedEvents.reduce((sum, e) => sum + e.profit, 0);
const avgCombinedCost = hedgedEvents.reduce((sum, e) => sum + e.combinedCost, 0) / hedgedEvents.length;
const profitableEvents = hedgedEvents.filter(e => e.profit > 0).length;
const winRate = (profitableEvents / hedgedEvents.length) * 100;

console.log(`总利润: $${totalProfit.toFixed(2)}`);
console.log(`平均组合成本: $${avgCombinedCost.toFixed(4)}`);
console.log(`盈利事件: ${profitableEvents}/${hedgedEvents.length} (${winRate.toFixed(1)}%)`);

// 15分钟 vs 1小时
const events15m = hedgedEvents.filter(e => e.is15min);
const events1h = hedgedEvents.filter(e => !e.is15min);

console.log(`\n15分钟事件: ${events15m.length} 个, 平均成本: $${(events15m.reduce((s, e) => s + e.combinedCost, 0) / events15m.length).toFixed(4)}`);
console.log(`1小时事件: ${events1h.length} 个, 平均成本: $${(events1h.reduce((s, e) => s + e.combinedCost, 0) / events1h.length).toFixed(4)}`);

// BTC vs ETH
const eventsBtc = hedgedEvents.filter(e => e.isBtc);
const eventsEth = hedgedEvents.filter(e => !e.isBtc);

console.log(`\nBTC 事件: ${eventsBtc.length} 个, 平均成本: $${(eventsBtc.reduce((s, e) => s + e.combinedCost, 0) / eventsBtc.length).toFixed(4)}`);
console.log(`ETH 事件: ${eventsEth.length} 个, 平均成本: $${(eventsEth.reduce((s, e) => s + e.combinedCost, 0) / eventsEth.length).toFixed(4)}`);

