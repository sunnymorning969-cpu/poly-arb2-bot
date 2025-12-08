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
 * 计算挂单价格
 * 目标：upPrice + downPrice < MAX_SAME_POOL_COST
 */
const calculateMakerPrices = (
  upBestAsk: number,
  downBestAsk: number,
  upBestBid: number,
  downBestBid: number
): { upPrice: number; downPrice: number } | null => {
  // 在 bestBid 上方一点点挂单（更容易成交）
  // 或者在 bestAsk 下方挂单（等待别人来吃）
  
  const spreadUp = upBestAsk - upBestBid;
  const spreadDown = downBestAsk - downBestBid;
  
  // 策略：在买一价上方 1-2 分挂单
  let upPrice = Math.min(upBestBid + 0.01, upBestAsk - 0.01);
  let downPrice = Math.min(downBestBid + 0.01, downBestAsk - 0.01);
  
  // 确保价格合理
  upPrice = Math.max(0.01, Math.min(0.99, upPrice));
  downPrice = Math.max(0.01, Math.min(0.99, downPrice));
  
  // 四舍五入到分
  upPrice = Math.round(upPrice * 100) / 100;
  downPrice = Math.round(downPrice * 100) / 100;
  
  const combinedCost = upPrice + downPrice;
  
  // 检查是否满足套利条件
  if (combinedCost >= CONFIG.MAX_SAME_POOL_COST) {
    // 尝试调整价格
    const targetCost = CONFIG.MAX_SAME_POOL_COST - 0.01;
    const adjustment = (combinedCost - targetCost) / 2;
    
    upPrice = Math.round((upPrice - adjustment) * 100) / 100;
    downPrice = Math.round((downPrice - adjustment) * 100) / 100;
    
    // 再次检查
    if (upPrice + downPrice >= CONFIG.MAX_SAME_POOL_COST) {
      return null; // 无法找到合适的价格
    }
    
    // 确保价格不低于 bestBid 太多（否则不容易成交）
    if (upPrice < upBestBid - 0.02 || downPrice < downBestBid - 0.02) {
      return null; // 价格太低，放弃
    }
  }
  
  return { upPrice, downPrice };
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
        const fillCost = Math.abs(diff) * downBook.bestAsk;
        stats.downFilled += Math.abs(diff);
        stats.downCost += fillCost;
        Logger.success(`   [模拟] 市价补单 ${Math.abs(diff)} Down @ $${downBook.bestAsk.toFixed(3)}`);
      }
    } else {
      // 需要补 Up
      const upBook = getOrderBook(market.upTokenId);
      if (upBook && upBook.bestAsk > 0) {
        const fillCost = Math.abs(diff) * upBook.bestAsk;
        stats.upFilled += Math.abs(diff);
        stats.upCost += fillCost;
        Logger.success(`   [模拟] 市价补单 ${Math.abs(diff)} Up @ $${upBook.bestAsk.toFixed(3)}`);
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
 * 挂单策略主函数
 */
export const runMakerStrategy = async (): Promise<void> => {
  const now = Date.now();
  
  // 检查挂单冷却时间
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
    
    // 检查是否接近结算时间（结算前2分钟停止挂单，专注平衡）
    const timeToEnd = market.endTime.getTime() - now;
    const isNearEnd = timeToEnd < 2 * 60 * 1000 && timeToEnd > 0;
    
    if (isNearEnd) {
      // 接近结算，检查并强制平衡
      await checkAndBalance(market.slug, stats, market);
      continue;
    }
    
    // 检查当前仓位是否已达到单边限制
    const currentImbalance = Math.abs(stats.upFilled - stats.downFilled);
    if (currentImbalance >= CONFIG.MAKER_MAX_IMBALANCE) {
      // 仓位失衡，尝试平衡
      await checkAndBalance(market.slug, stats, market);
      continue;
    }
    
    // 计算挂单价格
    const prices = calculateMakerPrices(
      upBook.bestAsk,
      downBook.bestAsk,
      upBook.bestBid,
      downBook.bestBid
    );
    
    if (!prices) {
      // 无法找到合适的挂单价格
      continue;
    }
    
    const { upPrice, downPrice } = prices;
    const combinedCost = upPrice + downPrice;
    const profitPercent = (1 - combinedCost) * 100;
    
    // 决定挂单数量（根据市场深度动态调整）
    // 取市场深度的 10-30%，但不超过配置的最大值
    const upDepth = upBook.bestAskSize || 10;
    const downDepth = downBook.bestAskSize || 10;
    const minDepth = Math.min(upDepth, downDepth);
    
    // 使用深度的 20%，最少 1，最多 MAKER_MAX_SHARES_PER_ORDER
    const depthBasedShares = Math.max(1, Math.floor(minDepth * 0.2));
    const maxByFunds = Math.floor(CONFIG.MAKER_ORDER_SIZE_USD / combinedCost);
    const shares = Math.min(depthBasedShares, maxByFunds, CONFIG.MAKER_MAX_SHARES_PER_ORDER);
    
    if (shares < 1) continue;
    
    // 根据当前失衡情况决定挂哪边
    const diff = stats.upFilled - stats.downFilled;
    const shouldPlaceUp = diff <= 0; // Up 少，挂 Up
    const shouldPlaceDown = diff >= 0; // Down 少，挂 Down
    
    // 显示挂单信息
    Logger.info(`📝 ${market.asset} 挂单: Up $${upPrice.toFixed(3)} (市场 $${upBook.bestBid.toFixed(3)}/$${upBook.bestAsk.toFixed(3)}) | Down $${downPrice.toFixed(3)} (市场 $${downBook.bestBid.toFixed(3)}/$${downBook.bestAsk.toFixed(3)}) | 组合 $${combinedCost.toFixed(4)} (${profitPercent.toFixed(2)}%)`);
    
    // 模拟模式
    if (CONFIG.SIMULATION_MODE) {
      // 真实挂单逻辑模拟：
      // 1. 如果挂单价格 >= bestAsk，相当于吃单，100% 成交（但价格用 bestAsk）
      // 2. 如果挂单价格 < bestAsk，是真正的挂单，成交概率很低（5-15%）
      
      let upFilled = 0;
      let downFilled = 0;
      let actualUpPrice = upPrice;
      let actualDownPrice = downPrice;
      
      // Up 挂单成交判断
      if (shouldPlaceUp) {
        if (upPrice >= upBook.bestAsk) {
          // 吃单模式：直接成交，但用 bestAsk 价格
          actualUpPrice = upBook.bestAsk;
          upFilled = shares;
          stats.upFilled += shares;
          stats.upCost += shares * actualUpPrice;
          Logger.success(`📗 [模拟] ${market.asset} Up ${shares} @ $${actualUpPrice.toFixed(3)} 吃单成交`);
        } else {
          // 挂单模式：低概率成交（真实市场需要等对手方）
          // 价格越接近 bestAsk，成交概率越高
          const spread = upBook.bestAsk - upBook.bestBid;
          const priceGap = upBook.bestAsk - upPrice;
          // 概率 = 5% 基础 + 最多 10%（价格越接近 bestAsk 越高）
          const fillChance = spread > 0 ? 0.05 + Math.max(0, (1 - priceGap / spread) * 0.10) : 0.05;
          
          if (Math.random() < fillChance) {
            upFilled = shares;
            stats.upFilled += shares;
            stats.upCost += shares * upPrice;
            Logger.success(`📗 [模拟] ${market.asset} Up ${shares} @ $${upPrice.toFixed(3)} 挂单成交 (${(fillChance*100).toFixed(0)}%)`);
          }
        }
      }
      
      // Down 挂单成交判断
      if (shouldPlaceDown) {
        if (downPrice >= downBook.bestAsk) {
          // 吃单模式
          actualDownPrice = downBook.bestAsk;
          downFilled = shares;
          stats.downFilled += shares;
          stats.downCost += shares * actualDownPrice;
          Logger.success(`📕 [模拟] ${market.asset} Down ${shares} @ $${actualDownPrice.toFixed(3)} 吃单成交`);
        } else {
          // 挂单模式
          const spread = downBook.bestAsk - downBook.bestBid;
          const priceGap = downBook.bestAsk - downPrice;
          const fillChance = spread > 0 ? 0.05 + Math.max(0, (1 - priceGap / spread) * 0.10) : 0.05;
          
          if (Math.random() < fillChance) {
            downFilled = shares;
            stats.downFilled += shares;
            stats.downCost += shares * downPrice;
            Logger.success(`📕 [模拟] ${market.asset} Down ${shares} @ $${downPrice.toFixed(3)} 挂单成交 (${(fillChance*100).toFixed(0)}%)`);
          }
        }
      }
      
      // 同步到 positions（供 Telegram 统计使用）
      if (upFilled > 0 || downFilled > 0) {
        addPosition({
          slug: market.slug,
          asset: market.asset,
          timeGroup: market.timeGroup,
          upShares: upFilled,
          downShares: downFilled,
          upCost: upFilled * (upFilled > 0 ? actualUpPrice : 0),
          downCost: downFilled * (downFilled > 0 ? actualDownPrice : 0),
          totalCost: upFilled * actualUpPrice + downFilled * actualDownPrice,
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
        Logger.info(`   📊 ${market.asset}: Up ${stats.upFilled} / Down ${stats.downFilled} (差额${imbalance >= 0 ? '+' : ''}${imbalance}) | 平均成本: $${avgCost.toFixed(4)}`);
      }
      
      continue;
    }
    
    // 实盘模式：挂限价单
    try {
      const client = await initClient();
      
      // 挂 Up 买单
      if (shouldPlaceUp) {
        const upOrderArgs = {
          side: Side.BUY,
          tokenID: market.upTokenId,
          amount: shares * upPrice,
          price: upPrice,
        };
        
        const upSignedOrder = await client.createMarketOrder(upOrderArgs);
        const upResp = await client.postOrder(upSignedOrder, OrderType.GTC);
        
        if (upResp.success && upResp.orderID) {
          activeOrders.set(upResp.orderID, {
            orderId: upResp.orderID,
            tokenId: market.upTokenId,
            side: 'up',
            price: upPrice,
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
          Logger.success(`📗 挂单 ${market.asset} Up ${shares} @ $${upPrice.toFixed(3)}`);
        }
      }
      
      // 挂 Down 买单
      if (shouldPlaceDown) {
        const downOrderArgs = {
          side: Side.BUY,
          tokenID: market.downTokenId,
          amount: shares * downPrice,
          price: downPrice,
        };
        
        const downSignedOrder = await client.createMarketOrder(downOrderArgs);
        const downResp = await client.postOrder(downSignedOrder, OrderType.GTC);
        
        if (downResp.success && downResp.orderID) {
          activeOrders.set(downResp.orderID, {
            orderId: downResp.orderID,
            tokenId: market.downTokenId,
            side: 'down',
            price: downPrice,
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
          Logger.success(`📕 挂单 ${market.asset} Down ${shares} @ $${downPrice.toFixed(3)}`);
        }
      }
      
    } catch (error) {
      Logger.error(`挂单失败: ${error}`);
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
    const avgCost = stats.upFilled > 0 && stats.downFilled > 0
      ? (stats.upCost / stats.upFilled + stats.downCost / stats.downFilled)
      : 0;
    
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

