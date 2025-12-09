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

// 每个市场的仓位状态
interface MarketState {
  upShares: number;
  upCost: number;
  downShares: number;
  downCost: number;
  lastTradeTime: number;
}

// 每个市场的状态
const marketStates: Map<string, MarketState> = new Map();

// 上次日志时间（节流）
let lastLogTime = 0;
const LOG_INTERVAL = 1000;

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
    });
  }
  return marketStates.get(slug)!;
};

/**
 * 判断是否应该买入
 * 
 * @param side 买入方向
 * @param price 当前价格
 * @param state 市场状态
 * @returns 是否买入
 */
const shouldBuy = (
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
    
    // 核心判断：组合成本必须 < 0.98
    return combinedCost < CONFIG.MAX_COMBINED_COST;
  }
  
  // 2. 对面没仓位 → 只要价格合理就买
  return price < 0.50;
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
    
    // ========== 检查不平衡限制 ==========
    const totalShares = state.upShares + state.downShares;
    if (totalShares > 0) {
      const imbalance = Math.abs(state.upShares - state.downShares);
      const imbalanceRatio = imbalance / totalShares;
      
      // 根据时长选择不平衡限制
      const maxImbalanceRatio = market.timeGroup === '15min'
        ? CONFIG.MAX_IMBALANCE_RATIO_15MIN
        : CONFIG.MAX_IMBALANCE_RATIO_1HR;
      
      // 如果已经太不平衡，优先买少的那边
      if (imbalanceRatio > maxImbalanceRatio) {
        const needSide = state.upShares < state.downShares ? 'up' : 'down';
        const needPrice = needSide === 'up' ? upBook.bestAsk : downBook.bestAsk;
        
        // 检查是否应该买入
        if (shouldBuy(needSide, needPrice, state)) {
          const orderBudget = Math.min(
            CONFIG.ORDER_SIZE_USD,
            CONFIG.MAX_ORDER_AMOUNT_USD,
            CONFIG.MAX_EVENT_INVESTMENT_USD - totalInvestment
          );
          const shares = Math.floor(orderBudget / needPrice);
          
          if (shares >= 1) {
            await executeBuy(market, needSide, needPrice, shares, state);
          }
        }
        
        continue;  // 优先平衡，不考虑其他方向
      }
    }
    
    // ========== 扫描 UP 和 DOWN 机会 ==========
    // 注意：不在同一轮同时买入 UP 和 DOWN
    const upShouldBuy = shouldBuy('up', upBook.bestAsk, state);
    const downShouldBuy = shouldBuy('down', downBook.bestAsk, state);
    
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
        CONFIG.MAX_ORDER_AMOUNT_USD,
        CONFIG.MAX_EVENT_INVESTMENT_USD - totalInvestment
      );
      const shares = Math.floor(orderBudget / upBook.bestAsk);
      
      if (shares >= 1) {
        await executeBuy(market, 'up', upBook.bestAsk, shares, state);
      }
    } else if (buyDown) {
      const orderBudget = Math.min(
        CONFIG.ORDER_SIZE_USD,
        CONFIG.MAX_ORDER_AMOUNT_USD,
        CONFIG.MAX_EVENT_INVESTMENT_USD - totalInvestment
      );
      const shares = Math.floor(orderBudget / downBook.bestAsk);
      
      if (shares >= 1) {
        await executeBuy(market, 'down', downBook.bestAsk, shares, state);
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
 * 执行买入
 */
const executeBuy = async (
  market: any,
  side: 'up' | 'down',
  price: number,
  shares: number,
  state: MarketState
): Promise<void> => {
  const now = Date.now();
  const cost = shares * price;
  
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
    } else {
      state.downShares += shares;
      state.downCost += cost;
    }
    state.lastTradeTime = now;
    
    const tag = otherShares > 0 ? '🔗' : '💰';
    Logger.success(`${tag} [模拟] 吃单 ${market.asset} ${side.toUpperCase()} ${shares} @ $${price.toFixed(3)} | 组合: $${combinedCost.toFixed(3)}`);
    
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
        amount: actualCost,
        price: maxPrice,
      };
      
      const signedOrder = await client.createMarketOrder(orderArgs);
      const resp = await client.postOrder(signedOrder, OrderType.FOK);
      
      if (resp.success) {
        // 更新状态 - 使用实际下单价格作为成本
        if (side === 'up') {
          state.upShares += shares;
          state.upCost += actualCost;
        } else {
          state.downShares += shares;
          state.downCost += actualCost;
        }
        state.lastTradeTime = now;
        
        // 重新计算实际组合成本
        const actualOtherAvgCost = otherShares > 0 ? otherCost / otherShares : 0;
        const actualCombinedCost = maxPrice + actualOtherAvgCost;
        
        const tag = otherShares > 0 ? '🔗' : '💰';
        Logger.success(`${tag} 吃单 ${market.asset} ${side.toUpperCase()} ${shares} @ $${maxPrice.toFixed(3)} | 组合: $${actualCombinedCost.toFixed(3)}`);
        
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
      } else {
        Logger.warning(`⚠️ 吃单未成交，等待下次扫描...`);
      }
    } catch (error) {
      Logger.error(`吃单失败: ${error}`);
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
