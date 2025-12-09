import { Side, OrderType } from '@polymarket/clob-client';
import CONFIG from './config';
import Logger from './logger';
import { initClient } from './client';
import { getOrderBook } from './orderbook-ws';
import { getMarkets } from './scanner';
import { addPosition } from './positions';

/**
 * 震荡网格策略
 * 
 * 核心逻辑：
 * 1. 事件开盘时，挂满所有网格单（UP从0.01-0.97，每0.01一档）
 * 2. 每个UP价格对应一个DOWN价格，确保组合成本 = MAX_COMBINED_COST
 * 3. 被动等待成交，实时监控盈亏
 * 4. 持有到结算
 */

// 网格挂单信息
interface GridOrder {
  orderId: string;
  gridLevel: number;  // 网格档位编号（1, 2, 3...）
  side: 'up' | 'down';
  price: number;
  shares: number;  // 总数量
  filledShares: number;  // 已成交数量
  remainingShares: number;  // 剩余数量
  timestamp: number;
  pairOrderId?: string;  // 配对订单ID
}

// 每个市场的网格状态
interface GridMarketState {
  upShares: number;
  upCost: number;
  downShares: number;
  downCost: number;
  gridOrders: GridOrder[];  // 所有网格挂单
  initialized: boolean;  // 是否已初始化网格
  initTime: number;  // 初始化时间
}

// 每个市场的状态
const marketStates: Map<string, GridMarketState> = new Map();

// 上次日志时间（节流）
let lastLogTime = 0;
const LOG_INTERVAL = 5000;  // 5秒日志一次

/**
 * 获取或创建市场状态
 */
const getMarketState = (slug: string): GridMarketState => {
  if (!marketStates.has(slug)) {
    marketStates.set(slug, {
      upShares: 0,
      upCost: 0,
      downShares: 0,
      downCost: 0,
      gridOrders: [],
      initialized: false,
      initTime: 0,
    });
  }
  return marketStates.get(slug)!;
};

/**
 * 挂网格限价单
 */
const placeGridOrder = async (
  market: any,
  side: 'up' | 'down',
  price: number,
  shares: number,
  state: GridMarketState,
  gridLevel: number,
  pairOrderId?: string
): Promise<string | null> => {
  const roundedPrice = parseFloat(price.toFixed(3));
  
  if (CONFIG.SIMULATION_MODE) {
    // 模拟模式：不真实下单，只记录
    const orderId = `grid-${side}-${roundedPrice}-${Date.now()}-${Math.random()}`;
    state.gridOrders.push({
      orderId,
      gridLevel,
      side,
      price: roundedPrice,
      shares,
      filledShares: 0,
      remainingShares: shares,
      timestamp: Date.now(),
      pairOrderId,
    });
    
    // 不打印单个挂单日志，批量初始化完成后统一汇报
    return orderId;
  }
  
  // 真实模式
  try {
    const client = await initClient();
    const tokenId = side === 'up' ? market.upTokenId : market.downTokenId;
    
    const orderArgs = {
      side: Side.BUY,
      tokenID: tokenId,
      size: shares,
      price: roundedPrice,
    };
    
    const signedOrder = await client.createOrder(orderArgs);
    const response = await client.postOrder(signedOrder, OrderType.GTC);
    
    const orderId = response.orderID;
    state.gridOrders.push({
      orderId,
      gridLevel,
      side,
      price: roundedPrice,
      shares,
      filledShares: 0,
      remainingShares: shares,
      timestamp: Date.now(),
      pairOrderId,
    });
    
    return orderId;
  } catch (error: any) {
    Logger.error(`❌ 挂网格单失败 ${market.asset} ${side.toUpperCase()}: ${error.message}`);
    return null;
  }
};

/**
 * 初始化市场网格（事件开盘时调用）
 */
const initializeGrid = async (market: any, state: GridMarketState): Promise<void> => {
  if (state.initialized) {
    return;  // 已初始化，跳过
  }
  
  Logger.info(`🌐 开始初始化网格 ${market.asset} (${market.title})`);
  
  const gridStep = CONFIG.GRID_STEP;
  const sharesPerLevel = CONFIG.GRID_SHARES_PER_LEVEL;
  const maxCombinedCost = CONFIG.MAX_COMBINED_COST;
  
  let totalOrders = 0;
  let gridLevel = 1;  // 档位编号从1开始
  
  // 从0.01开始，到0.97结束（确保DOWN >= 0.015）
  for (let upPrice = 0.01; upPrice <= 0.97; upPrice += gridStep) {
    const downPrice = maxCombinedCost - upPrice;
    
    // 确保DOWN价格在合理范围内
    if (downPrice < 0.01 || downPrice > 0.99) {
      continue;
    }
    
    // 挂UP单（使用当前档位编号）
    const upOrderId = await placeGridOrder(market, 'up', upPrice, sharesPerLevel, state, gridLevel);
    
    // 挂配对的DOWN单（使用同一档位编号）
    const downOrderId = await placeGridOrder(market, 'down', downPrice, sharesPerLevel, state, gridLevel, upOrderId || undefined);
    
    // 设置配对关系
    if (upOrderId && downOrderId) {
      const upOrder = state.gridOrders.find(o => o.orderId === upOrderId);
      if (upOrder) {
        upOrder.pairOrderId = downOrderId;
      }
    }
    
    totalOrders += 2;
    gridLevel++;  // 下一档
    
    // 每10档休息一下，避免API限流
    if (totalOrders % 20 === 0) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  
  state.initialized = true;
  state.initTime = Date.now();
  
  // 统计价格区间
  const upPrices = state.gridOrders.filter(o => o.side === 'up').map(o => o.price);
  const downPrices = state.gridOrders.filter(o => o.side === 'down').map(o => o.price);
  const minUp = Math.min(...upPrices);
  const maxUp = Math.max(...upPrices);
  const minDown = Math.min(...downPrices);
  const maxDown = Math.max(...downPrices);
  
  Logger.success(`✅ 网格初始化完成 ${market.asset}: 共挂 ${totalOrders} 单 (${totalOrders/2} 档)`);
  Logger.info(`   📊 UP档位: $${minUp.toFixed(3)} - $${maxUp.toFixed(3)} | DOWN档位: $${minDown.toFixed(3)} - $${maxDown.toFixed(3)}`);
  Logger.info(`   ⏰ 网格已就位，开始被动等待市场成交...`);
};

/**
 * 检查网格挂单成交状态（模拟模式）
 */
const checkGridOrderFills = (market: any, state: GridMarketState): void => {
  if (!CONFIG.SIMULATION_MODE) {
    return;  // 真实模式需要查询API
  }
  
  // 初始化后延迟3秒再开始检查成交，避免日志混乱
  const timeSinceInit = Date.now() - state.initTime;
  if (timeSinceInit < 3000) {
    return;
  }
  
  const upBook = getOrderBook(market.upTokenId);
  const downBook = getOrderBook(market.downTokenId);
  
  if (!upBook || !downBook) {
    return;
  }
  
  // 检查每个未完全成交的挂单
  for (const order of state.gridOrders) {
    if (order.remainingShares <= 0) {
      continue;  // 已全部成交
    }
    
    // 模拟成交逻辑：
    // 我们挂的是买单(BUY)，当市场卖单价格 <= 我们的买单价格时，会成交
    const book = order.side === 'up' ? upBook : downBook;
    const currentBestAsk = book.bestAsk;
    
    if (order.price >= currentBestAsk) {
      // 市场价格触及挂单价格，模拟成交
      const fillChance = Math.random();
      if (fillChance > 0.90) {  // 10%概率成交（网格成交率较低）
        // 随机成交部分（10%-50%）
        const fillRatio = 0.1 + Math.random() * 0.4;
        const actualFillShares = Math.max(1, Math.ceil(order.remainingShares * fillRatio));
        
        if (actualFillShares > 0) {
          // 更新订单状态
          order.filledShares += actualFillShares;
          order.remainingShares -= actualFillShares;
          
          // 更新持仓
          if (order.side === 'up') {
            state.upShares += actualFillShares;
            state.upCost += actualFillShares * order.price;
          } else {
            state.downShares += actualFillShares;
            state.downCost += actualFillShares * order.price;
          }
          
          // 记录到positions
          const upShares = order.side === 'up' ? actualFillShares : 0;
          const upCost = order.side === 'up' ? actualFillShares * order.price : 0;
          const downShares = order.side === 'down' ? actualFillShares : 0;
          const downCost = order.side === 'down' ? actualFillShares * order.price : 0;
          
          addPosition({
            slug: market.slug,
            asset: market.asset,
            timeGroup: market.timeGroup,
            upShares,
            downShares,
            upCost,
            downCost,
            totalCost: upCost + downCost,
            timestamp: Date.now(),
            endTime: market.endTime,
          });
          
          const pairOrder = order.pairOrderId ? state.gridOrders.find(o => o.orderId === order.pairOrderId) : null;
          const combinedCost = pairOrder ? order.price + pairOrder.price : 0;
          const fillPercent = (order.filledShares / order.shares * 100).toFixed(0);
          
          Logger.success(`✅ 🔗 [模拟] 网格#${order.gridLevel}成交 ${market.asset} ${order.side.toUpperCase()} ${actualFillShares}/${order.shares} shares (累计${fillPercent}%) @ $${order.price.toFixed(3)} | 配对价: $${combinedCost.toFixed(3)}`);
        }
      }
    }
  }
};

/**
 * 计算当前盈亏
 */
const calculatePnL = (market: any, state: GridMarketState): { unrealizedPnL: number; investedCost: number } => {
  const upBook = getOrderBook(market.upTokenId);
  const downBook = getOrderBook(market.downTokenId);
  
  if (!upBook || !downBook) {
    return { unrealizedPnL: 0, investedCost: 0 };
  }
  
  const totalCost = state.upCost + state.downCost;
  
  // 未实现盈亏 = 当前市值 - 总成本
  const currentUpValue = state.upShares * upBook.bestBid;
  const currentDownValue = state.downShares * downBook.bestBid;
  const currentValue = currentUpValue + currentDownValue;
  
  const unrealizedPnL = currentValue - totalCost;
  
  return { unrealizedPnL, investedCost: totalCost };
};

/**
 * 主策略函数（网格模式）
 */
export const runGridStrategy = async (): Promise<void> => {
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
    
    // 如果未初始化且不接近结束，初始化网格
    if (!state.initialized && !isNearEnd) {
      await initializeGrid(market, state);
    }
    
    // 检查挂单成交状态
    checkGridOrderFills(market, state);
    
    // 计算盈亏
    const { unrealizedPnL, investedCost } = calculatePnL(market, state);
    
    // 日志输出
    if (shouldLog && state.initialized) {
      const avgUp = state.upShares > 0 ? state.upCost / state.upShares : 0;
      const avgDown = state.downShares > 0 ? state.downCost / state.downShares : 0;
      const combinedCost = avgUp + avgDown;
      const imbalance = state.upShares - state.downShares;
      
      // 统计成交情况
      let fullyFilledOrders = 0;
      let partiallyFilledOrders = 0;
      let pendingOrders = 0;
      let totalFilledShares = 0;
      let totalShares = 0;
      
      for (const order of state.gridOrders) {
        totalShares += order.shares;
        totalFilledShares += order.filledShares;
        if (order.remainingShares === 0) {
          fullyFilledOrders++;
        } else if (order.filledShares > 0) {
          partiallyFilledOrders++;
        } else {
          pendingOrders++;
        }
      }
      
      const fillRate = totalShares > 0 ? (totalFilledShares / totalShares * 100).toFixed(1) : '0.0';
      
      if (state.upShares > 0 || state.downShares > 0) {
        Logger.info(`📊 ${market.asset}: UP ${state.upShares.toFixed(0)} @ $${avgUp.toFixed(3)} | DOWN ${state.downShares.toFixed(0)} @ $${avgDown.toFixed(3)} | 组合: $${combinedCost.toFixed(3)} | 不平衡: ${imbalance > 0 ? '+' : ''}${imbalance.toFixed(0)}`);
        Logger.info(`   💰 投入: $${investedCost.toFixed(2)} | 未实现盈亏: ${unrealizedPnL >= 0 ? '+' : ''}$${unrealizedPnL.toFixed(2)} (${unrealizedPnL >= 0 ? '+' : ''}${(unrealizedPnL / investedCost * 100).toFixed(2)}%)`);
        Logger.info(`   🌐 网格: 完成${fullyFilledOrders} | 部分${partiallyFilledOrders} | 待成交${pendingOrders} | 总成交率${fillRate}%`);
      }
    }
  }
  
  if (shouldLog) {
    lastLogTime = now;
  }
};

/**
 * 获取网格统计信息
 */
export const getGridStats = (): {
  totalUp: number;
  totalUpCost: number;
  totalDown: number;
  totalDownCost: number;
  avgCost: number;
  totalPendingOrders: number;
  totalFilledOrders: number;
} => {
  let totalUp = 0;
  let totalUpCost = 0;
  let totalDown = 0;
  let totalDownCost = 0;
  let totalPendingOrders = 0;
  let totalFilledOrders = 0;
  
  for (const state of marketStates.values()) {
    totalUp += state.upShares;
    totalUpCost += state.upCost;
    totalDown += state.downShares;
    totalDownCost += state.downCost;
    
    for (const order of state.gridOrders) {
      if (order.remainingShares === 0) {
        totalFilledOrders++;
      } else if (order.filledShares > 0) {
        totalFilledOrders += 0.5;  // 部分成交算0.5个
        totalPendingOrders += 0.5;
      } else {
        totalPendingOrders++;
      }
    }
  }
  
  const avgUp = totalUp > 0 ? totalUpCost / totalUp : 0;
  const avgDown = totalDown > 0 ? totalDownCost / totalDown : 0;
  const avgCost = avgUp + avgDown;
  
  return {
    totalUp,
    totalUpCost,
    totalDown,
    totalDownCost,
    avgCost,
    totalPendingOrders,
    totalFilledOrders,
  };
};

/**
 * 取消所有挂单（事件结束或需要重置时）
 */
export const cancelAllGridOrders = async (): Promise<void> => {
  if (CONFIG.SIMULATION_MODE) {
    Logger.info('📝 [模拟] 清空所有网格挂单');
    marketStates.clear();
    return;
  }
  
  const client = await initClient();
  
  for (const [slug, state] of marketStates.entries()) {
    for (const order of state.gridOrders) {
      if (order.remainingShares > 0) {
        try {
          await client.cancelOrder({ orderID: order.orderId });
          Logger.info(`✅ 取消挂单 ${slug} ${order.side.toUpperCase()} @ $${order.price.toFixed(3)}`);
        } catch (error: any) {
          Logger.error(`❌ 取消挂单失败: ${error.message}`);
        }
      }
    }
  }
  
  marketStates.clear();
};
