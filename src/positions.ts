import axios from 'axios';
import CONFIG from './config';
import Logger from './logger';

// 仓位信息
export interface Position {
  slug: string;
  asset: 'BTC' | 'ETH';
  timeGroup: '15min' | '1hr';
  upShares: number;
  downShares: number;
  upCost: number;
  downCost: number;
  totalCost: number;
  timestamp: number;
  endTime: Date;
}

// 结算结果
export interface SettlementResult {
  position: Position;
  outcome: 'up' | 'down';
  payout: number;
  profit: number;
}

// 存储仓位
const positions: Map<string, Position> = new Map();

// 统计数据
let totalSettled = 0;
let totalProfit = 0;
let winCount = 0;
let lossCount = 0;

// 添加仓位（累加）
export const addPosition = (pos: Position) => {
  const existing = positions.get(pos.slug);
  
  if (existing) {
    // 累加到现有仓位
    existing.upShares += pos.upShares;
    existing.downShares += pos.downShares;
    existing.upCost += pos.upCost;
    existing.downCost += pos.downCost;
    existing.totalCost += pos.totalCost;
  } else {
    positions.set(pos.slug, { ...pos });
  }
};

// 获取所有仓位
export const getPositions = (): Position[] => {
  return Array.from(positions.values());
};

// 获取仓位数量
export const getPositionCount = (): number => {
  return positions.size;
};

// 获取总成本
export const getTotalCost = (): number => {
  let total = 0;
  positions.forEach(p => total += p.totalCost);
  return total;
};

// 获取预期利润（如果所有仓位都配对完美）
export const getExpectedProfit = (): number => {
  let profit = 0;
  positions.forEach(p => {
    const paired = Math.min(p.upShares, p.downShares);
    profit += paired - (p.upCost + p.downCost) * (paired / Math.max(p.upShares, p.downShares, 1));
  });
  return profit;
};

// 获取统计数据
export const getStats = () => ({
  totalSettled,
  totalProfit,
  winCount,
  lossCount,
  winRate: totalSettled > 0 ? (winCount / totalSettled) * 100 : 0,
});

// 获取市场真实结果
export const fetchRealOutcome = async (slug: string): Promise<'up' | 'down' | null> => {
  try {
    const response = await axios.get(`${CONFIG.POLYMARKET_API}/markets?slug=${slug}`, {
      timeout: 10000,
    });
    
    const markets = response.data;
    if (!markets || markets.length === 0) return null;
    
    const market = markets[0];
    
    // 检查 outcomePrices
    let outcomePrices = market.outcomePrices;
    if (typeof outcomePrices === 'string') {
      outcomePrices = JSON.parse(outcomePrices);
    }
    
    if (outcomePrices && outcomePrices.length >= 2) {
      // 通常 index 0 = Up, index 1 = Down
      const upPrice = parseFloat(outcomePrices[0]);
      const downPrice = parseFloat(outcomePrices[1]);
      
      // 结算后，获胜方价格 = 1，失败方价格 = 0
      if (upPrice > 0.9) return 'up';
      if (downPrice > 0.9) return 'down';
    }
    
    // 检查 winningOutcome 字段
    if (market.winningOutcome) {
      const winner = market.winningOutcome.toLowerCase();
      if (winner === 'up' || winner === 'yes') return 'up';
      if (winner === 'down' || winner === 'no') return 'down';
    }
    
    return null;
  } catch (error) {
    return null;
  }
};

// 检查并结算过期仓位
export const checkAndSettleExpired = async (): Promise<SettlementResult[]> => {
  const now = Date.now();
  const results: SettlementResult[] = [];
  const toRemove: string[] = [];
  
  for (const [slug, position] of positions) {
    // 检查是否过期（结束时间 + 2分钟缓冲）
    if (position.endTime.getTime() + 2 * 60 * 1000 > now) {
      continue;
    }
    
    // 获取真实结果
    let outcome: 'up' | 'down' | null = null;
    
    outcome = await fetchRealOutcome(slug);
    
    // 如果还没有结果，稍后再试
    if (!outcome) {
      // 超过5分钟还没结果，用模拟
      if (now - position.endTime.getTime() > 5 * 60 * 1000) {
        if (CONFIG.SIMULATION_MODE) {
          outcome = Math.random() > 0.5 ? 'up' : 'down';
        } else {
          continue; // 实盘模式继续等待
        }
      } else {
        continue;
      }
    }
    
    // 计算盈亏
    const pairedShares = Math.min(position.upShares, position.downShares);
    let payout = 0;
    
    if (outcome === 'up') {
      payout = position.upShares; // Up shares 每个价值 $1
    } else {
      payout = position.downShares; // Down shares 每个价值 $1
    }
    
    const profit = payout - position.totalCost;
    
    results.push({
      position,
      outcome,
      payout,
      profit,
    });
    
    // 更新统计
    totalSettled++;
    totalProfit += profit;
    if (profit >= 0) {
      winCount++;
    } else {
      lossCount++;
    }
    
    toRemove.push(slug);
    
    Logger.arbitrage(`📊 ${position.asset} ${position.timeGroup} 结算: ${outcome.toUpperCase()} 获胜 | 成本 $${position.totalCost.toFixed(2)} → 收回 $${payout.toFixed(2)} | ${profit >= 0 ? '✅' : '❌'} ${profit >= 0 ? '+' : ''}$${profit.toFixed(2)}`);
  }
  
  // 移除已结算仓位
  toRemove.forEach(slug => positions.delete(slug));
  
  return results;
};

// 获取仓位汇总（按时间组）
export const getPositionSummary = () => {
  const summary: {
    [key: string]: {
      totalUp: number;
      totalDown: number;
      totalCost: number;
      expectedProfit: number;
      positions: Position[];
    };
  } = {};
  
  positions.forEach(p => {
    const key = p.timeGroup;
    if (!summary[key]) {
      summary[key] = {
        totalUp: 0,
        totalDown: 0,
        totalCost: 0,
        expectedProfit: 0,
        positions: [],
      };
    }
    
    summary[key].totalUp += p.upShares;
    summary[key].totalDown += p.downShares;
    summary[key].totalCost += p.totalCost;
    summary[key].positions.push(p);
  });
  
  // 计算每组的预期利润
  Object.values(summary).forEach(s => {
    const paired = Math.min(s.totalUp, s.totalDown);
    s.expectedProfit = paired - s.totalCost * (paired / Math.max(s.totalUp, s.totalDown, 1));
  });
  
  return summary;
};
