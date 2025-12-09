import { Side, OrderType } from '@polymarket/clob-client';
import CONFIG from './config';
import Logger from './logger';
import { initClient } from './client';
import { getOrderBook } from './orderbook-ws';
import { getMarkets } from './scanner';
import { addPosition } from './positions';

/**
 * 动态吃单策略（总成本控制版）
 * 
 * 核心逻辑：
 * 1. 扫描订单簿，计算当前持仓平均成本
 * 2. 如果 avgCost + newPrice < 0.98，立即吃单
 * 3. 不强制平衡，接受一定不平衡（期望值为正）
 * 4. 持有到结算，不卖出
 */

// 挂单信息
interface PendingOrder {
  orderId: string;
  side: 'up' | 'down';
  price: number;
  shares: number;
  timestamp: number;
}

// 每个市场的仓位状态
interface MarketState {
  upShares: number;
  upCost: number;
  downShares: number;
  downCost: number;
  lastTradeTime: number;
  lastUpPrice: number;    // 上次买入UP的价格
  lastDownPrice: number;  // 上次买入DOWN的价格
  pendingOrders: PendingOrder[];  // 挂单列表
}

// 每个市场的状态
const marketStates: Map<string, MarketState> = new Map();

// 上次日志时间（节流）
let lastLogTime = 0;
const LOG_INTERVAL = 1000;

// 交易冷却时间
const MARKET_COOLDOWN_MS = 1500;  // 同一市场1.5秒冷却
let lastGlobalTradeTime = 0;
const GLOBAL_TRADE_INTERVAL_MS = 500;  // 全局0.5秒间隔

/**
 * 获取或创建市场状态
 */
const getMarketState = (slug: string): MarketState => {
  if (!marketStates.has(slug)) {
    marketStates.set(slug, {
      upShares: 0,
      upCost: 0,
      downShares: 0,
      downCost: 0,
      lastTradeTime: 0,
      lastUpPrice: 0,
      lastDownPrice: 0,
      pendingOrders: [],
    });
  }
  return marketStates.get(slug)!;
};

/**
 * 判断是否应该Taker吃单
 * 
 * @param side 买入方向
 * @param price 当前价格
 * @param state 市场状态
 * @returns 是否买入
 */
const shouldTakerBuy = (
  side: 'up' | 'down',
  price: number,
  state: MarketState
): boolean => {
  const otherSide = side === 'up' ? 'down' : 'up';
  const otherShares = otherSide === 'up' ? state.upShares : state.downShares;
  const otherCost = otherSide === 'up' ? state.upCost : state.downCost;
  
  // 1. 对面有仓位 → 检查组合成本
  if (otherShares > 0) {
    const otherAvgCost = otherCost / otherShares;
    const combinedCost = price + otherAvgCost;
    
    // 核心判断：组合成本必须 < 0.985
    return combinedCost < CONFIG.MAX_COMBINED_COST;
  }
  
  // 2. 对面没仓位 → 只要价格合理就买（会触发挂配对单）
  return price < 0.49;
};

/**
 * 下限价单（Maker挂单）
 */
const placeLimitOrder = async (
  market: any,
  side: 'up' | 'down',
  price: number,
  shares: number,
  state: MarketState
): Promise<void> => {
  if (CONFIG.SIMULATION_MODE) {
    // 模拟模式：不真实下单，只记录
    const orderId = `sim-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    state.pendingOrders.push({
      orderId,
      side,
      price,
      shares,
      timestamp: Date.now(),
    });
    
    Logger.info(`📝 [模拟] 挂单 ${market.asset} ${side.toUpperCase()} ${shares} @ $${price.toFixed(3)} (等待成交)`);
  } else {
    // 实盘模式：真实下单
    try {
      const client = await initClient();
      const tokenId = side === 'up' ? market.upTokenId : market.downTokenId;
      
      const orderArgs = {
        side: Side.BUY,
        tokenID: tokenId,
        size: shares,  // 数量
        price: price,  // 价格
      };
      
      const signedOrder = await client.createOrder(orderArgs);
      const resp = await client.postOrder(signedOrder, OrderType.GTC);  // Good-Till-Cancel
      
      if (resp.success && resp.orderID) {
        state.pendingOrders.push({
          orderId: resp.orderID,
          side,
          price,
          shares,
          timestamp: Date.now(),
        });
        
        Logger.success(`📝 挂单 ${market.asset} ${side.toUpperCase()} ${shares} @ $${price.toFixed(3)} (订单ID: ${resp.orderID.substring(0, 8)}...)`);
      } else {
        Logger.warning(`⚠️ 挂单失败: ${market.asset} ${side.toUpperCase()}`);
      }
    } catch (error) {
      Logger.error(`挂单错误: ${error}`);
    }
  }
};

/**
 * 主策略函数（动态吃单）
 */
export const runMakerStrategy = async (): Promise<void> => {
  const now = Date.now();
  const shouldLog = now - lastLogTime >= LOG_INTERVAL;
  
  const markets = getMarkets();
  
  for (const market of markets) {
    const upBook = getOrderBook(market.upTokenId);
    const downBook = getOrderBook(market.downTokenId);
    
    if (!upBook || !downBook || upBook.bestAsk <= 0 || downBook.bestAsk <= 0) {
      continue;
    }
    
    const state = getMarketState(market.slug);
    
    // 检查是否接近结算时间
    const timeToEnd = market.endTime.getTime() - now;
    const isNearEnd = timeToEnd < 2 * 60 * 1000 && timeToEnd > 0;  // 2分钟内
    
    // 事件快结束时不开新仓位
    if (isNearEnd) {
      continue;
    }
    
    // ========== 检查投资限制 ==========
    const totalInvestment = state.upCost + state.downCost;
    if (totalInvestment >= CONFIG.MAX_EVENT_INVESTMENT_USD) {
      if (shouldLog) {
        Logger.info(`📊 ${market.asset} 已达上限: $${totalInvestment.toFixed(2)} / $${CONFIG.MAX_EVENT_INVESTMENT_USD}`);
      }
      continue;
    }
    
    // ========== 检查挂单成交状态 ==========
    await checkPendingOrders(market, state);
    
    // ========== 扫描 UP 和 DOWN 机会 ==========
    // 注意：不在同一轮同时买入 UP 和 DOWN
    const upShouldBuy = shouldTakerBuy('up', upBook.bestAsk, state);
    const downShouldBuy = shouldTakerBuy('down', downBook.bestAsk, state);
    
    // 如果两边都能买，选择更便宜的那边（组合成本更低）
    let buyUp = false;
    let buyDown = false;
    
    if (upShouldBuy && downShouldBuy) {
      // 计算两边的组合成本
      const upAvgCost = state.upShares > 0 ? state.upCost / state.upShares : 0;
      const downAvgCost = state.downShares > 0 ? state.downCost / state.downShares : 0;
      
      const upCombinedCost = upBook.bestAsk + downAvgCost;
      const downCombinedCost = downBook.bestAsk + upAvgCost;
      
      // 选择组合成本更低的那边
      if (upCombinedCost <= downCombinedCost) {
        buyUp = true;
      } else {
        buyDown = true;
      }
    } else if (upShouldBuy) {
      buyUp = true;
    } else if (downShouldBuy) {
      buyDown = true;
    }
    
    // 执行买入
    if (buyUp) {
      const orderBudget = Math.min(
        CONFIG.ORDER_SIZE_USD,
        CONFIG.MAX_EVENT_INVESTMENT_USD - totalInvestment
      );
      const shares = Math.floor(orderBudget / upBook.bestAsk);
      
      if (shares >= 1) {
        const success = await executeTakerBuy(market, 'up', upBook.bestAsk, shares, state);
        
        // 如果成功且对面没仓位，挂配对单
        if (success && state.downShares === 0) {
          const targetDownPrice = CONFIG.MAX_COMBINED_COST - upBook.bestAsk - 0.01;  // 留1%安全边际
          if (targetDownPrice > 0.1 && targetDownPrice < 0.9) {
            await placeLimitOrder(market, 'down', targetDownPrice, shares, state);
          }
        }
      }
    } else if (buyDown) {
      const orderBudget = Math.min(
        CONFIG.ORDER_SIZE_USD,
        CONFIG.MAX_EVENT_INVESTMENT_USD - totalInvestment
      );
      const shares = Math.floor(orderBudget / downBook.bestAsk);
      
      if (shares >= 1) {
        const success = await executeTakerBuy(market, 'down', downBook.bestAsk, shares, state);
        
        // 如果成功且对面没仓位，挂配对单
        if (success && state.upShares === 0) {
          const targetUpPrice = CONFIG.MAX_COMBINED_COST - downBook.bestAsk - 0.01;  // 留1%安全边际
          if (targetUpPrice > 0.1 && targetUpPrice < 0.9) {
            await placeLimitOrder(market, 'up', targetUpPrice, shares, state);
          }
        }
      }
    }
    
    // ========== 日志输出（节流） ==========
    if (shouldLog && (state.upShares > 0 || state.downShares > 0)) {
      const avgUp = state.upShares > 0 ? state.upCost / state.upShares : 0;
      const avgDown = state.downShares > 0 ? state.downCost / state.downShares : 0;
      const combinedCost = avgUp + avgDown;
      const imbalance = state.upShares - state.downShares;
      
      Logger.info(`📊 仓位 ${market.asset}: UP ${state.upShares.toFixed(0)} @ $${avgUp.toFixed(3)} | DOWN ${state.downShares.toFixed(0)} @ $${avgDown.toFixed(3)} | 不平衡: ${imbalance > 0 ? '+' : ''}${imbalance.toFixed(0)} | 组合: $${combinedCost.toFixed(3)}`);
    }
  }
  
  if (shouldLog) {
    lastLogTime = now;
  }
};

/**
 * 检查挂单成交状态
 */
const checkPendingOrders = async (market: any, state: MarketState): Promise<void> => {
  if (state.pendingOrders.length === 0) return;
  
  const now = Date.now();
  
  if (CONFIG.SIMULATION_MODE) {
    // 模拟模式：随机成交挂单（5%概率）
    const newPendingOrders: PendingOrder[] = [];
    
    for (const order of state.pendingOrders) {
      const age = now - order.timestamp;
      
      // 挂单超过10秒，5%概率成交
      if (age > 10000 && Math.random() < 0.05) {
        // 模拟成交
        if (order.side === 'up') {
          state.upShares += order.shares;
          state.upCost += order.shares * order.price;
          state.lastUpPrice = order.price;
        } else {
          state.downShares += order.shares;
          state.downCost += order.shares * order.price;
          state.lastDownPrice = order.price;
        }
        
        Logger.success(`🔗 [模拟] 挂单成交 ${market.asset} ${order.side.toUpperCase()} ${order.shares} @ $${order.price.toFixed(3)}`);
        
        // 同步到 positions
        addPosition({
          slug: market.slug,
          asset: market.asset,
          timeGroup: market.timeGroup,
          upShares: order.side === 'up' ? order.shares : 0,
          downShares: order.side === 'down' ? order.shares : 0,
          upCost: order.side === 'up' ? order.shares * order.price : 0,
          downCost: order.side === 'down' ? order.shares * order.price : 0,
          totalCost: order.shares * order.price,
          timestamp: now,
          endTime: market.endTime,
        });
      } else {
        // 未成交，保留
        newPendingOrders.push(order);
      }
    }
    
    state.pendingOrders = newPendingOrders;
  } else {
    // 实盘模式：调用API检查订单状态
    // TODO: 实现真实订单状态查询
  }
};

/**
 * 执行Taker买入（立即成交）
 */
const executeTakerBuy = async (
  market: any,
  side: 'up' | 'down',
  price: number,
  shares: number,
  state: MarketState
): Promise<boolean> => {
  const now = Date.now();
  const cost = shares * price;
  
  // 更新全局交易时间
  lastGlobalTradeTime = now;
  
  // 计算组合成本
  const otherSide = side === 'up' ? 'down' : 'up';
  const otherShares = otherSide === 'up' ? state.upShares : state.downShares;
  const otherCost = otherSide === 'up' ? state.upCost : state.downCost;
  const otherAvgCost = otherShares > 0 ? otherCost / otherShares : 0;
  const combinedCost = price + otherAvgCost;
  
  if (CONFIG.SIMULATION_MODE) {
    // 模拟成交
    if (side === 'up') {
      state.upShares += shares;
      state.upCost += cost;
      state.lastUpPrice = price;
    } else {
      state.downShares += shares;
      state.downCost += cost;
      state.lastDownPrice = price;
    }
    state.lastTradeTime = now;
    
    const tag = otherShares > 0 ? '🔗' : '💰';
    Logger.success(`${tag} [模拟] Taker吃单 ${market.asset} ${side.toUpperCase()} ${shares} @ $${price.toFixed(3)} | 组合: $${combinedCost.toFixed(3)}`);
    
    // 同步到 positions
    addPosition({
      slug: market.slug,
      asset: market.asset,
      timeGroup: market.timeGroup,
      upShares: side === 'up' ? shares : 0,
      downShares: side === 'down' ? shares : 0,
      upCost: side === 'up' ? cost : 0,
      downCost: side === 'down' ? cost : 0,
      totalCost: cost,
      timestamp: now,
      endTime: market.endTime,
    });
    
    return true;
  } else {
    // 实盘交易
    try {
      const client = await initClient();
      const tokenId = side === 'up' ? market.upTokenId : market.downTokenId;
      
      // 价格放宽 1% 防止滑点
      const maxPrice = Math.min(price + 0.01, 0.99);
      const actualCost = shares * maxPrice;  // 使用实际下单价格计算成本
      
      const orderArgs = {
        side: Side.BUY,
        tokenID: tokenId,
        size: shares,
        price: maxPrice,
      };
      
      const signedOrder = await client.createOrder(orderArgs);
      const resp = await client.postOrder(signedOrder, OrderType.FOK);
      
      if (resp.success) {
        // 更新状态 - 使用实际下单价格作为成本
        if (side === 'up') {
          state.upShares += shares;
          state.upCost += actualCost;
          state.lastUpPrice = maxPrice;
        } else {
          state.downShares += shares;
          state.downCost += actualCost;
          state.lastDownPrice = maxPrice;
        }
        state.lastTradeTime = now;
        
        // 重新计算实际组合成本
        const actualOtherAvgCost = otherShares > 0 ? otherCost / otherShares : 0;
        const actualCombinedCost = maxPrice + actualOtherAvgCost;
        
        const tag = otherShares > 0 ? '🔗' : '💰';
        Logger.success(`${tag} Taker吃单 ${market.asset} ${side.toUpperCase()} ${shares} @ $${maxPrice.toFixed(3)} | 组合: $${actualCombinedCost.toFixed(3)}`);
        
        // 同步到 positions
        addPosition({
          slug: market.slug,
          asset: market.asset,
          timeGroup: market.timeGroup,
          upShares: side === 'up' ? shares : 0,
          downShares: side === 'down' ? shares : 0,
          upCost: side === 'up' ? actualCost : 0,
          downCost: side === 'down' ? actualCost : 0,
          totalCost: actualCost,
          timestamp: now,
          endTime: market.endTime,
        });
        
        return true;
      } else {
        Logger.warning(`⚠️ Taker吃单未成交，等待下次扫描...`);
        return false;
      }
    } catch (error) {
      Logger.error(`Taker吃单失败: ${error}`);
      return false;
    }
  }
};

/**
 * 检查订单状态（实盘模式）- 不再需要
 */
export const checkOrderStatus = async (): Promise<void> => {
  // 动态吃单策略不需要检查订单状态
};

/**
 * 获取统计
 */
export const getMakerStats = (): {
  totalUp: number;
  totalUpCost: number;
  totalDown: number;
  totalDownCost: number;
  avgCost: number;
  pendingPairs: number;
} => {
  let totalUp = 0;
  let totalUpCost = 0;
  let totalDown = 0;
  let totalDownCost = 0;
  
  for (const [_, state] of marketStates) {
    totalUp += state.upShares;
    totalUpCost += state.upCost;
    totalDown += state.downShares;
    totalDownCost += state.downCost;
  }
  
  const avgUpCost = totalUp > 0 ? totalUpCost / totalUp : 0;
  const avgDownCost = totalDown > 0 ? totalDownCost / totalDown : 0;
  const avgCost = avgUpCost + avgDownCost;
  
  // 不平衡数量
  const pendingPairs = Math.abs(totalUp - totalDown);
  
  return {
    totalUp,
    totalUpCost,
    totalDown,
    totalDownCost,
    avgCost,
    pendingPairs,
  };
};

/**
 * 清除指定事件的状态（事件结束时调用）
 */
export const clearMarketState = (slug: string): void => {
  marketStates.delete(slug);
};

/**
 * 取消所有挂单（退出时调用）- 不再需要
 */
export const cancelAllOrders = async (): Promise<void> => {
  Logger.info('动态吃单策略无挂单需要取消');
};
