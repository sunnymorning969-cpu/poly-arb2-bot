import { Side, OrderType } from '@polymarket/clob-client';
import CONFIG from './config';
import Logger from './logger';
import { initClient } from './client';
import { getOrderBook } from './orderbook-ws';
import { getMarkets } from './scanner';
import { addPosition, Position } from './positions';
import { notifyEventSummary } from './telegram';

// 活跃订单
interface ActiveOrder {
  orderId: string;
  tokenId: string;
  side: 'up' | 'down';
  price: number;
  size: number;
  filled: number;
  market: {
    slug: string;
    asset: 'BTC' | 'ETH';
    timeGroup: '15min' | '1hr';
    endTime: Date;
  };
  createdAt: number;
}

// 周期统计
interface CycleStats {
  upFilled: number;
  upCost: number;
  downFilled: number;
  downCost: number;
  orders: ActiveOrder[];
}

// 每个市场的周期统计
const cycleStats: Map<string, CycleStats> = new Map();

// 活跃订单列表
const activeOrders: Map<string, ActiveOrder> = new Map();

// 上次挂单时间
let lastMakerTime = 0;

// 上次日志输出时间（节流用）
let lastLogTime = 0;
const LOG_INTERVAL = 1000; // 日志间隔 1 秒

/**
 * 初始化周期统计
 */
const initCycleStats = (slug: string): CycleStats => {
  return {
    upFilled: 0,
    upCost: 0,
    downFilled: 0,
    downCost: 0,
    orders: [],
  };
};

/**
 * 获取或创建周期统计
 */
const getCycleStats = (slug: string): CycleStats => {
  if (!cycleStats.has(slug)) {
    cycleStats.set(slug, initCycleStats(slug));
  }
  return cycleStats.get(slug)!;
};

/**
 * 策略决策结果
 */
interface TradeDecision {
  upAction: 'taker' | 'maker' | 'skip';
  downAction: 'taker' | 'maker' | 'skip';
  upPrice: number;
  downPrice: number;
  reason: string;
}

/**
 * 智能策略决策 - "双边挂单 + Taker配对"
 * 
 * 数据分析发现（15000笔交易）：
 * - 91% Maker，9% Taker
 * - 100% 事件 Maker 先成交
 * - 配对平均 20 秒，不是同时
 * - 75% 交易在前半段完成
 * - Down Taker 比例 12.5%，Up 只有 4%
 * 
 * 策略：
 * 1. 有失衡 → Taker 吃单配对
 * 2. 无失衡 → 双边挂 Maker 单
 */
const makeTradeDecision = (
  upBestAsk: number,
  downBestAsk: number,
  upBestBid: number,
  downBestBid: number,
  imbalance: number = 0,
  upAvgCost: number = 0,
  downAvgCost: number = 0
): TradeDecision => {
  let upAction: 'taker' | 'maker' | 'skip' = 'skip';
  let downAction: 'taker' | 'maker' | 'skip' = 'skip';
  let upPrice = 0;
  let downPrice = 0;
  let reason = '';
  
  const needMoreDown = imbalance > 0;  // Up 多，需要 Down
  const needMoreUp = imbalance < 0;    // Down 多，需要 Up
  
  // ========== 优先级1：有失衡，Taker 配对 ==========
  if (needMoreDown && upAvgCost > 0) {
    const maxDownPrice = CONFIG.MAX_COMBINED_COST - upAvgCost;
    if (downBestAsk <= maxDownPrice) {
      downAction = 'taker';
      downPrice = downBestAsk;
      reason = `🔗 Taker配对 Down$${downBestAsk.toFixed(2)} (组合$${(upAvgCost + downBestAsk).toFixed(2)})`;
      return { upAction, downAction, upPrice, downPrice, reason };
    }
  }
  
  if (needMoreUp && downAvgCost > 0) {
    const maxUpPrice = CONFIG.MAX_COMBINED_COST - downAvgCost;
    if (upBestAsk <= maxUpPrice) {
      upAction = 'taker';
      upPrice = upBestAsk;
      reason = `🔗 Taker配对 Up$${upBestAsk.toFixed(2)} (组合$${(downAvgCost + upBestAsk).toFixed(2)})`;
      return { upAction, downAction, upPrice, downPrice, reason };
    }
  }
  
  // ========== 优先级2：双边挂 Maker 单（核心！91%的交易）==========
  const potentialUpPrice = Math.round((upBestBid + CONFIG.MAKER_OFFSET) * 100) / 100;
  const potentialDownPrice = Math.round((downBestBid + CONFIG.MAKER_OFFSET) * 100) / 100;
  const combinedMakerCost = potentialUpPrice + potentialDownPrice;
  
  if (combinedMakerCost < CONFIG.MAX_COMBINED_COST) {
    const upInRange = potentialUpPrice >= CONFIG.UP_PRICE_MIN && potentialUpPrice <= CONFIG.UP_PRICE_MAX;
    const downInRange = potentialDownPrice >= CONFIG.DOWN_PRICE_MIN && potentialDownPrice <= CONFIG.DOWN_PRICE_MAX;
    
    if (upInRange && downInRange) {
      upAction = 'maker';
      downAction = 'maker';
      upPrice = potentialUpPrice;
      downPrice = potentialDownPrice;
      reason = `📝 双边Maker Up$${upPrice.toFixed(2)}+Down$${downPrice.toFixed(2)}=$${combinedMakerCost.toFixed(2)}`;
      return { upAction, downAction, upPrice, downPrice, reason };
    }
  }
  
  // ========== 优先级3：等待 ==========
  reason = `⏳ 组合$${combinedMakerCost.toFixed(2)}>${CONFIG.MAX_COMBINED_COST}，等待`;
  return { upAction, downAction, upPrice, downPrice, reason };
};

/**
 * 检查并平衡仓位
 */
const checkAndBalance = async (slug: string, stats: CycleStats, market: any): Promise<void> => {
  const diff = stats.upFilled - stats.downFilled;
  
  if (Math.abs(diff) < CONFIG.MAKER_MAX_IMBALANCE) {
    return; // 差额在允许范围内
  }
  
  Logger.warning(`⚖️ ${market.asset} 仓位失衡: Up ${stats.upFilled} / Down ${stats.downFilled} (差额: ${diff > 0 ? '+' : ''}${diff})`);
  
  // 如果是模拟模式，只记录
  if (CONFIG.SIMULATION_MODE) {
    Logger.info(`   [模拟] 需要补单 ${Math.abs(diff)} shares ${diff > 0 ? 'Down' : 'Up'}`);
    
    // 模拟补单
    if (diff > 0) {
      // 需要补 Down
      const downBook = getOrderBook(market.downTokenId);
      if (downBook && downBook.bestAsk > 0) {
        const sharesToFill = Math.abs(diff);
        const fillCost = sharesToFill * downBook.bestAsk;
        stats.downFilled += sharesToFill;
        stats.downCost += fillCost;
        
        // 同步到 positions
        addPosition({
          slug: market.slug,
          asset: market.asset,
          timeGroup: market.timeGroup,
          upShares: 0,
          downShares: sharesToFill,
          upCost: 0,
          downCost: fillCost,
          totalCost: fillCost,
          timestamp: Date.now(),
          endTime: market.endTime,
        });
        
        Logger.success(`   [模拟] 市价补单 ${sharesToFill} Down @ $${downBook.bestAsk.toFixed(3)}`);
      }
    } else {
      // 需要补 Up
      const upBook = getOrderBook(market.upTokenId);
      if (upBook && upBook.bestAsk > 0) {
        const sharesToFill = Math.abs(diff);
        const fillCost = sharesToFill * upBook.bestAsk;
        stats.upFilled += sharesToFill;
        stats.upCost += fillCost;
        
        // 同步到 positions
        addPosition({
          slug: market.slug,
          asset: market.asset,
          timeGroup: market.timeGroup,
          upShares: sharesToFill,
          downShares: 0,
          upCost: fillCost,
          downCost: 0,
          totalCost: fillCost,
          timestamp: Date.now(),
          endTime: market.endTime,
        });
        
        Logger.success(`   [模拟] 市价补单 ${sharesToFill} Up @ $${upBook.bestAsk.toFixed(3)}`);
      }
    }
    return;
  }
  
  // 实盘模式：市价补单
  try {
    const client = await initClient();
    
    if (diff > 0) {
      // 需要补 Down
      const downBook = getOrderBook(market.downTokenId);
      if (!downBook || downBook.bestAsk <= 0) return;
      
      const price = Math.min(downBook.bestAsk * 1.01, 0.99);
      const amount = Math.abs(diff) * price;
      
      const orderArgs = {
        side: Side.BUY,
        tokenID: market.downTokenId,
        amount,
        price,
      };
      
      const signedOrder = await client.createMarketOrder(orderArgs);
      const resp = await client.postOrder(signedOrder, OrderType.FOK);
      
      if (resp.success) {
        stats.downFilled += Math.abs(diff);
        stats.downCost += amount;
        Logger.success(`   ✅ 市价补单 ${Math.abs(diff)} Down @ $${price.toFixed(3)}`);
      }
    } else {
      // 需要补 Up
      const upBook = getOrderBook(market.upTokenId);
      if (!upBook || upBook.bestAsk <= 0) return;
      
      const price = Math.min(upBook.bestAsk * 1.01, 0.99);
      const amount = Math.abs(diff) * price;
      
      const orderArgs = {
        side: Side.BUY,
        tokenID: market.upTokenId,
        amount,
        price,
      };
      
      const signedOrder = await client.createMarketOrder(orderArgs);
      const resp = await client.postOrder(signedOrder, OrderType.FOK);
      
      if (resp.success) {
        stats.upFilled += Math.abs(diff);
        stats.upCost += amount;
        Logger.success(`   ✅ 市价补单 ${Math.abs(diff)} Up @ $${price.toFixed(3)}`);
      }
    }
  } catch (error) {
    Logger.error(`补单失败: ${error}`);
  }
};

/**
 * 主策略函数（91% Maker + 9% Taker配对）
 * 基于数据分析：15000笔交易，100%胜率，平均成本$0.9894
 */
export const runMakerStrategy = async (): Promise<void> => {
  const now = Date.now();
  
  // 检查冷却时间
  if (now - lastMakerTime < CONFIG.MAKER_INTERVAL_MS) {
    return;
  }
  lastMakerTime = now;
  
  const markets = getMarkets();
  
  for (const market of markets) {
    const upBook = getOrderBook(market.upTokenId);
    const downBook = getOrderBook(market.downTokenId);
    
    if (!upBook || !downBook) continue;
    if (upBook.bestAsk <= 0 || downBook.bestAsk <= 0) continue;
    if (upBook.bestBid <= 0 || downBook.bestBid <= 0) continue;
    
    const stats = getCycleStats(market.slug);
    
    // 检查是否接近结算时间（结算前2分钟停止交易，专注平衡）
    const timeToEnd = market.endTime.getTime() - now;
    const isNearEnd = timeToEnd < 2 * 60 * 1000 && timeToEnd > 0;
    
    if (isNearEnd) {
      await checkAndBalance(market.slug, stats, market);
      continue;
    }
    
    // 检查仓位失衡
    const currentImbalance = Math.abs(stats.upFilled - stats.downFilled);
    if (currentImbalance >= CONFIG.MAKER_MAX_IMBALANCE) {
      await checkAndBalance(market.slug, stats, market);
      continue;
    }
    
    // 计算当前仓位的平均成本
    const imbalance = stats.upFilled - stats.downFilled;
    const upAvgCost = stats.upFilled > 0 ? stats.upCost / stats.upFilled : 0;
    const downAvgCost = stats.downFilled > 0 ? stats.downCost / stats.downFilled : 0;
    
    // 智能策略决策（传入仓位信息，支持先买后配对）
    const decision = makeTradeDecision(
      upBook.bestAsk,
      downBook.bestAsk,
      upBook.bestBid,
      downBook.bestBid,
      imbalance,
      upAvgCost,
      downAvgCost
    );
    
    // 如果两边都跳过，继续（不输出日志减少噪音）
    if (decision.upAction === 'skip' && decision.downAction === 'skip') {
      continue;
    }
    
    // 日志节流：非成交日志每秒只输出一次
    const shouldLog = Date.now() - lastLogTime >= LOG_INTERVAL;
    
    // 计算交易数量
    const upDepth = upBook.bestAskSize || 10;
    const downDepth = downBook.bestAskSize || 10;
    const minDepth = Math.min(upDepth, downDepth);
    
    // 吃单用更大的量（深度的30%），挂单用较小的量（深度的15%）
    const takerShares = Math.max(1, Math.floor(minDepth * 0.3));
    const makerShares = Math.max(1, Math.floor(minDepth * 0.15));
    
    // 限制最大数量
    const maxByFunds = Math.floor(CONFIG.MAKER_ORDER_SIZE_USD / Math.max(decision.upPrice, decision.downPrice, 0.5));
    
    // 根据仓位差额调整挂单方向
    const diff = stats.upFilled - stats.downFilled;
    const needMoreUp = diff < 0;  // Up 少
    const needMoreDown = diff > 0;  // Down 少
    
    // 显示决策信息（每秒最多一次）
    if (shouldLog) {
      Logger.info(`🎯 ${market.asset}: ${decision.reason}`);
      Logger.info(`   市场: Up $${upBook.bestBid.toFixed(3)}/$${upBook.bestAsk.toFixed(3)} | Down $${downBook.bestBid.toFixed(3)}/$${downBook.bestAsk.toFixed(3)}`);
      lastLogTime = Date.now();
    }
    
    // 模拟模式
    if (CONFIG.SIMULATION_MODE) {
      let upFilled = 0;
      let downFilled = 0;
      let upCost = 0;
      let downCost = 0;
      
      // 模拟逻辑（基于数据分析：91% Maker，配对平均20秒）
      const isBothMaker = decision.upAction === 'maker' && decision.downAction === 'maker';
      
      if (isBothMaker) {
        // 双边 Maker 模拟（核心逻辑！）
        // 数据显示：Maker 单独成交是正常的，之后用 Taker 配对
        const combinedMakerPrice = decision.upPrice + decision.downPrice;
        
        if (combinedMakerPrice < CONFIG.MAX_COMBINED_COST) {
          // 模拟单边成交（更接近真实：一边先成交，后续配对）
          const fillChance = 0.05; // 5% 单边成交概率
          const shares = Math.min(makerShares, maxByFunds, CONFIG.MAKER_MAX_SHARES_PER_ORDER);
          
          // Up 成交
          if (Math.random() < fillChance) {
            upFilled = shares;
            upCost = shares * decision.upPrice;
            stats.upFilled += shares;
            stats.upCost += upCost;
            Logger.success(`📗 [模拟] Maker成交 ${market.asset} Up ${shares} @ $${decision.upPrice.toFixed(3)}`);
          }
          
          // Down 成交（独立概率）
          if (Math.random() < fillChance) {
            downFilled = shares;
            downCost = shares * decision.downPrice;
            stats.downFilled += shares;
            stats.downCost += downCost;
            Logger.success(`📕 [模拟] Maker成交 ${market.asset} Down ${shares} @ $${decision.downPrice.toFixed(3)}`);
          }
          
          // 如果双边都成交，显示组合成本
          if (upFilled > 0 && downFilled > 0) {
            Logger.success(`   💰 双边成交! 组合$${combinedMakerPrice.toFixed(3)}`);
          }
        }
      } else {
        // Taker 配对模式：100% 成交
        const shares = Math.min(takerShares, maxByFunds, CONFIG.MAKER_MAX_SHARES_PER_ORDER);
        
        if (decision.upAction === 'taker') {
          upFilled = shares;
          upCost = shares * decision.upPrice;
          stats.upFilled += shares;
          stats.upCost += upCost;
          Logger.success(`📗 [模拟] Taker配对 ${market.asset} Up ${shares} @ $${decision.upPrice.toFixed(3)}`);
        }
        
        if (decision.downAction === 'taker') {
          downFilled = shares;
          downCost = shares * decision.downPrice;
          stats.downFilled += shares;
          stats.downCost += downCost;
          Logger.success(`📕 [模拟] Taker配对 ${market.asset} Down ${shares} @ $${decision.downPrice.toFixed(3)}`);
        }
      }
      
      // 同步到 positions（单边或双边成交都记录）
      if (upFilled > 0 || downFilled > 0) {
        addPosition({
          slug: market.slug,
          asset: market.asset,
          timeGroup: market.timeGroup,
          upShares: upFilled,
          downShares: downFilled,
          upCost: upCost,
          downCost: downCost,
          totalCost: upCost + downCost,
          timestamp: Date.now(),
          endTime: market.endTime,
        });
      }
      
      // 显示当前状态
      if (stats.upFilled > 0 || stats.downFilled > 0) {
        const avgCost = stats.upFilled > 0 && stats.downFilled > 0
          ? (stats.upCost / stats.upFilled + stats.downCost / stats.downFilled)
          : 0;
        const imbalance = stats.upFilled - stats.downFilled;
        const paired = Math.min(stats.upFilled, stats.downFilled);
        const expectedProfit = paired > 0 ? paired * (1 - avgCost) : 0;
        Logger.info(`   📊 仓位: Up ${stats.upFilled} / Down ${stats.downFilled} (差额${imbalance >= 0 ? '+' : ''}${imbalance}) | 平均成本: $${avgCost.toFixed(4)} | 预期利润: $${expectedProfit.toFixed(2)}`);
      }
      
      continue;
    }
    
    // 实盘模式
    try {
      const client = await initClient();
      const shouldTradeUp = (needMoreUp || diff === 0) && decision.upAction !== 'skip';
      const shouldTradeDown = (needMoreDown || diff === 0) && decision.downAction !== 'skip';
      
      // Up 交易
      if (shouldTradeUp) {
        const shares = decision.upAction === 'taker' 
          ? Math.min(takerShares, maxByFunds, CONFIG.MAKER_MAX_SHARES_PER_ORDER)
          : Math.min(makerShares, maxByFunds, CONFIG.MAKER_MAX_SHARES_PER_ORDER);
        
        const orderType = decision.upAction === 'taker' ? OrderType.FOK : OrderType.GTC;
        
        const upOrderArgs = {
          side: Side.BUY,
          tokenID: market.upTokenId,
          amount: shares * decision.upPrice,
          price: decision.upPrice,
        };
        
        const upSignedOrder = await client.createMarketOrder(upOrderArgs);
        const upResp = await client.postOrder(upSignedOrder, orderType);
        
        if (upResp.success) {
          if (decision.upAction === 'taker') {
            stats.upFilled += shares;
            stats.upCost += shares * decision.upPrice;
            Logger.success(`📗 吃单成交 ${market.asset} Up ${shares} @ $${decision.upPrice.toFixed(3)}`);
          } else if (upResp.orderID) {
            activeOrders.set(upResp.orderID, {
              orderId: upResp.orderID,
              tokenId: market.upTokenId,
              side: 'up',
              price: decision.upPrice,
              size: shares,
              filled: 0,
              market: {
                slug: market.slug,
                asset: market.asset,
                timeGroup: market.timeGroup,
                endTime: market.endTime,
              },
              createdAt: now,
            });
            Logger.success(`📗 挂单 ${market.asset} Up ${shares} @ $${decision.upPrice.toFixed(3)}`);
          }
        }
      }
      
      // Down 交易
      if (shouldTradeDown) {
        const shares = decision.downAction === 'taker'
          ? Math.min(takerShares, maxByFunds, CONFIG.MAKER_MAX_SHARES_PER_ORDER)
          : Math.min(makerShares, maxByFunds, CONFIG.MAKER_MAX_SHARES_PER_ORDER);
        
        const orderType = decision.downAction === 'taker' ? OrderType.FOK : OrderType.GTC;
        
        const downOrderArgs = {
          side: Side.BUY,
          tokenID: market.downTokenId,
          amount: shares * decision.downPrice,
          price: decision.downPrice,
        };
        
        const downSignedOrder = await client.createMarketOrder(downOrderArgs);
        const downResp = await client.postOrder(downSignedOrder, orderType);
        
        if (downResp.success) {
          if (decision.downAction === 'taker') {
            stats.downFilled += shares;
            stats.downCost += shares * decision.downPrice;
            Logger.success(`📕 吃单成交 ${market.asset} Down ${shares} @ $${decision.downPrice.toFixed(3)}`);
          } else if (downResp.orderID) {
            activeOrders.set(downResp.orderID, {
              orderId: downResp.orderID,
              tokenId: market.downTokenId,
              side: 'down',
              price: decision.downPrice,
              size: shares,
              filled: 0,
              market: {
                slug: market.slug,
                asset: market.asset,
                timeGroup: market.timeGroup,
                endTime: market.endTime,
              },
              createdAt: now,
            });
            Logger.success(`📕 挂单 ${market.asset} Down ${shares} @ $${decision.downPrice.toFixed(3)}`);
          }
        }
      }
      
    } catch (error) {
      Logger.error(`交易失败: ${error}`);
    }
  }
};

/**
 * 检查订单状态并更新统计
 */
export const checkOrderStatus = async (): Promise<void> => {
  if (CONFIG.SIMULATION_MODE || activeOrders.size === 0) return;
  
  const now = Date.now();
  
  try {
    const client = await initClient();
    
    for (const [orderId, order] of activeOrders) {
      try {
        // 检查订单对应的事件是否已过期（结束前1分钟就开始撤单）
        const timeToEnd = order.market.endTime.getTime() - now;
        if (timeToEnd < 60 * 1000) {
          // 事件即将结束，撤销订单
          await client.cancelOrder({ orderID: orderId });
          activeOrders.delete(orderId);
          Logger.warning(`🚫 撤销过期订单: ${order.market.asset} ${order.side.toUpperCase()} (事件即将结束)`);
          continue;
        }
        
        const orderStatus = await client.getOrder(orderId);
        
        if (!orderStatus) {
          activeOrders.delete(orderId);
          continue;
        }
        
        const filledSize = parseFloat(orderStatus.size_matched || '0');
        const newFilled = filledSize - order.filled;
        
        if (newFilled > 0) {
          order.filled = filledSize;
          
          const stats = getCycleStats(order.market.slug);
          if (order.side === 'up') {
            stats.upFilled += newFilled;
            stats.upCost += newFilled * order.price;
          } else {
            stats.downFilled += newFilled;
            stats.downCost += newFilled * order.price;
          }
          
          Logger.success(`✅ 订单成交: ${order.market.asset} ${order.side.toUpperCase()} ${newFilled} @ $${order.price.toFixed(3)}`);
          
          // 记录仓位
          addPosition({
            slug: order.market.slug,
            asset: order.market.asset,
            timeGroup: order.market.timeGroup,
            upShares: order.side === 'up' ? newFilled : 0,
            downShares: order.side === 'down' ? newFilled : 0,
            upCost: order.side === 'up' ? newFilled * order.price : 0,
            downCost: order.side === 'down' ? newFilled * order.price : 0,
            totalCost: newFilled * order.price,
            timestamp: Date.now(),
            endTime: order.market.endTime,
          });
        }
        
        // 订单完全成交或被取消
        if (orderStatus.status === 'MATCHED' || orderStatus.status === 'CANCELED') {
          activeOrders.delete(orderId);
        }
        
        // 订单超时（超过30秒未完全成交则取消）
        if (now - order.createdAt > 30000 && order.filled < order.size) {
          await client.cancelOrder({ orderID: orderId });
          activeOrders.delete(orderId);
          Logger.info(`⏰ 取消超时订单: ${order.market.asset} ${order.side.toUpperCase()}`);
        }
        
      } catch (error) {
        // 订单可能已不存在
        activeOrders.delete(orderId);
      }
    }
  } catch (error) {
    Logger.error(`检查订单状态失败: ${error}`);
  }
};

/**
 * 撤销指定事件的所有订单（事件切换时调用）
 */
export const cancelOrdersForSlug = async (slug: string): Promise<void> => {
  // 获取该事件的统计（发送总结前）
  const stats = cycleStats.get(slug);
  
  // 从 slug 解析资产和时间组
  const is15min = slug.includes('15m');
  const isBtc = slug.includes('btc') || slug.includes('bitcoin');
  const asset = isBtc ? 'BTC' : 'ETH';
  const timeGroup = is15min ? '15min' : '1hr';
  
  // 发送事件总结（如果有成交）
  if (stats && (stats.upFilled > 0 || stats.downFilled > 0)) {
    // 计算平均组合成本（只有两边都有成交才有意义）
    const upAvg = stats.upFilled > 0 ? stats.upCost / stats.upFilled : 0;
    const downAvg = stats.downFilled > 0 ? stats.downCost / stats.downFilled : 0;
    const avgCost = stats.upFilled > 0 && stats.downFilled > 0 ? upAvg + downAvg : -1; // -1 表示无效
    
    await notifyEventSummary({
      slug,
      asset,
      timeGroup,
      upFilled: stats.upFilled,
      upCost: stats.upCost,
      downFilled: stats.downFilled,
      downCost: stats.downCost,
      avgCost,
      imbalance: stats.upFilled - stats.downFilled,
    });
    
    Logger.info(`📋 ${asset} ${timeGroup} 周期结束: Up ${stats.upFilled} / Down ${stats.downFilled} | 成本 $${(stats.upCost + stats.downCost).toFixed(2)}`);
  }
  
  if (CONFIG.SIMULATION_MODE) {
    // 模拟模式：清除该事件的统计
    cycleStats.delete(slug);
    return;
  }
  
  const ordersToCancel: string[] = [];
  
  for (const [orderId, order] of activeOrders) {
    if (order.market.slug === slug) {
      ordersToCancel.push(orderId);
    }
  }
  
  if (ordersToCancel.length === 0) {
    cycleStats.delete(slug);
    return;
  }
  
  try {
    const client = await initClient();
    
    for (const orderId of ordersToCancel) {
      try {
        await client.cancelOrder({ orderID: orderId });
        activeOrders.delete(orderId);
      } catch (error) {
        // 忽略取消错误
        activeOrders.delete(orderId);
      }
    }
    
    Logger.info(`🚫 已撤销 ${ordersToCancel.length} 个 ${slug} 的挂单`);
    
    // 清除该事件的统计
    cycleStats.delete(slug);
    
  } catch (error) {
    Logger.error(`撤销订单失败: ${error}`);
  }
};

/**
 * 获取挂单统计
 */
export const getMakerStats = (): { 
  totalUp: number; 
  totalDown: number; 
  totalUpCost: number;
  totalDownCost: number;
  avgCost: number;
  activeOrders: number;
} => {
  let totalUp = 0;
  let totalDown = 0;
  let totalUpCost = 0;
  let totalDownCost = 0;
  
  for (const stats of cycleStats.values()) {
    totalUp += stats.upFilled;
    totalDown += stats.downFilled;
    totalUpCost += stats.upCost;
    totalDownCost += stats.downCost;
  }
  
  const avgCost = totalUp > 0 && totalDown > 0
    ? (totalUpCost / totalUp + totalDownCost / totalDown)
    : 0;
  
  return {
    totalUp,
    totalDown,
    totalUpCost,
    totalDownCost,
    avgCost,
    activeOrders: activeOrders.size,
  };
};

/**
 * 重置周期统计（新周期开始时调用）
 */
export const resetCycleStats = (slug: string): void => {
  cycleStats.set(slug, initCycleStats(slug));
};

/**
 * 取消所有活跃订单
 */
export const cancelAllOrders = async (): Promise<void> => {
  if (CONFIG.SIMULATION_MODE || activeOrders.size === 0) return;
  
  try {
    const client = await initClient();
    
    for (const [orderId] of activeOrders) {
      try {
        await client.cancelOrder({ orderID: orderId });
      } catch (error) {
        // 忽略取消错误
      }
    }
    
    activeOrders.clear();
    Logger.info('🚫 已取消所有挂单');
  } catch (error) {
    Logger.error(`取消订单失败: ${error}`);
  }
};

