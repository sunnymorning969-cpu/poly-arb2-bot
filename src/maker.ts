import { Side, OrderType } from '@polymarket/clob-client';
import CONFIG from './config';
import Logger from './logger';
import { initClient } from './client';
import { getOrderBook } from './orderbook-ws';
import { getMarkets } from './scanner';
import { addPosition } from './positions';

/**
 * Maker + Taker 策略（低价挂单等待版）
 * 
 * 核心逻辑：
 * 1. 计算目标价格 = MAX_COST - 对面bestAsk - 安全边际
 * 2. 在目标价挂单，耐心等待被吃
 * 3. 只有能挂更低价格时才撤单重挂
 * 4. 部分成交后绝不撤单
 * 5. 成交后立即 Taker 配对
 */

// 单个挂单槽位
interface MakerSlot {
  price: number;
  shares: number;
  orderId: string | null;
  filled: number;      // 已成交
  pairedFilled: number; // 已配对
  cost: number;        // 成交成本
}

// 每个市场的仓位状态
interface MarketState {
  makerSide: 'up' | 'down';
  slots: MakerSlot[];     // 多个挂单槽位
  
  // Taker 端总计
  takerFilled: number;
  takerCost: number;
  
  // 状态
  lastUpdate: number;
  firstUnpairedTime: number;
}

// 配对超时时间 - 超过后接受更高价格配对
const PAIRING_TIMEOUT_MS = CONFIG.PAIRING_TIMEOUT_SEC * 1000;

// 挂单检查间隔 (秒) - 检查是否能挂更低价格
const ORDER_CHECK_SEC = 5;

// 安全边际 - 组合成本要低于阈值多少才挂单
const SAFETY_MARGIN = 0.01;

// 价格改善阈值 - 新价格比旧价格低多少才撤单重挂
const PRICE_IMPROVE_THRESHOLD = 0.01;

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
      makerSide: 'up',
      slots: [],
      takerFilled: 0,
      takerCost: 0,
      lastUpdate: 0,
      firstUnpairedTime: 0,
    });
  }
  return marketStates.get(slug)!;
};

/**
 * 计算状态汇总
 */
const getStateStats = (state: MarketState) => {
  const totalMakerFilled = state.slots.reduce((sum, s) => sum + s.filled, 0);
  const totalMakerCost = state.slots.reduce((sum, s) => sum + s.cost, 0);
  const totalPending = state.slots.reduce((sum, s) => sum + (s.shares - s.filled), 0);
  const totalUnpaired = state.slots.reduce((sum, s) => sum + (s.filled - s.pairedFilled), 0);
  const avgMakerPrice = totalMakerFilled > 0 ? totalMakerCost / totalMakerFilled : 0;
  
  return { totalMakerFilled, totalMakerCost, totalPending, totalUnpaired, avgMakerPrice };
};

/**
 * 决定哪边挂 Maker（选择便宜的那边）
 * 便宜的一边挂 Maker 可以获得更好的价格
 */
const decideMakerSide = (
  upBestAsk: number,
  downBestAsk: number
): 'up' | 'down' => {
  // 哪边的 bestAsk 更低，就挂那边的 Maker
  // 因为 Maker 挂在 bestBid 上方，价格比 bestAsk 更好
  return upBestAsk < downBestAsk ? 'up' : 'down';
};

/**
 * 计算目标挂单价格（低价等待版）
 * 
 * 策略：目标价 = MAX_COST - 对面bestAsk - 安全边际
 * 这样即使对面价格略涨，我们仍有利润空间
 * 
 * @param otherSideBestAsk 另一边的 bestAsk（Taker配对价格）
 * @param budget 预算
 * @returns 挂单价格和数量，null 表示无法挂单
 */
const calculateTargetOrder = (
  otherSideBestAsk: number,
  budget: number
): { price: number; shares: number } | null => {
  // 目标价格 = 阈值 - 对面价格 - 安全边际
  // 例如：0.995 - 0.60 - 0.01 = 0.385
  const targetPrice = Math.round((CONFIG.MAX_SAME_POOL_COST - otherSideBestAsk - SAFETY_MARGIN) * 100) / 100;
  
  // 价格范围检查（不能太低或太高）
  if (targetPrice < 0.10 || targetPrice > 0.90) {
    return null;
  }
  
  // 计算数量
  const shares = Math.floor(budget / targetPrice);
  if (shares < 1) return null;
  
  return { price: targetPrice, shares };
};


/**
 * 主策略函数（多档分布挂单）
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
    const stats = getStateStats(state);
    
    // 检查是否接近结算时间（2分钟内停止新挂单）
    const timeToEnd = market.endTime.getTime() - now;
    if (timeToEnd < 2 * 60 * 1000 && timeToEnd > 0) {
      continue;
    }
    
    // ========== 步骤1：模拟 Maker 成交 ==========
    // 真实逻辑：买单价格越高越容易被吃
    if (CONFIG.SIMULATION_MODE && state.slots.length > 0) {
      const makerBook = state.makerSide === 'up' ? upBook : downBook;
      const bestBid = makerBook.bestBid;  // 当前最高买价
      const bestAsk = makerBook.bestAsk;  // 当前最低卖价
      
      for (const slot of state.slots) {
        const pending = slot.shares - slot.filled;
        if (pending <= 0) continue;
        
        // 成交概率取决于我们的挂单价格与市场的关系
        let fillProb = 0;
        
        if (slot.price >= bestAsk) {
          // 价格 >= bestAsk：相当于吃单，100%成交
          fillProb = 1.0;
        } else if (slot.price >= bestBid) {
          // 价格在 bestBid 和 bestAsk 之间：我们是最优买单，有机会被卖家吃
          fillProb = 0.03;  // 3% 概率
        } else {
          // 价格 < bestBid：我们排在队列后面，很难成交
          fillProb = 0.005;  // 0.5% 概率
        }
        
        if (Math.random() < fillProb) {
          const fillAmount = Math.min(pending, Math.ceil(Math.random() * 2));
          slot.filled += fillAmount;
          slot.cost += fillAmount * slot.price;
          
          Logger.success(`📗 [模拟] Maker成交 ${market.asset} ${state.makerSide.toUpperCase()} ${fillAmount} @ $${slot.price.toFixed(3)}`);
        }
      }
    }
    
    // ========== 步骤2：检查是否需要 Taker 配对 ==========
    const totalUnpaired = state.slots.reduce((sum, s) => sum + (s.filled - s.pairedFilled), 0);
    
    if (totalUnpaired > 0) {
      const takerSide = state.makerSide === 'up' ? 'down' : 'up';
      const takerBook = takerSide === 'up' ? upBook : downBook;
      const takerPrice = takerBook.bestAsk;
      
      // 计算已成交 Maker 的平均价格
      const filledSlots = state.slots.filter(s => s.filled > 0);
      const avgMakerPrice = filledSlots.reduce((sum, s) => sum + s.cost, 0) / 
                           filledSlots.reduce((sum, s) => sum + s.filled, 0);
      const combinedCost = avgMakerPrice + takerPrice;
      
      // 记录首次未配对时间
      if (state.firstUnpairedTime === 0) {
        state.firstUnpairedTime = now;
      }
      
      const waitingTime = now - state.firstUnpairedTime;
      const isTimeout = waitingTime > PAIRING_TIMEOUT_MS;
      const costThreshold = isTimeout ? 1.0 : CONFIG.MAX_SAME_POOL_COST;
      
      if (combinedCost < costThreshold) {
        const isForced = isTimeout && combinedCost >= CONFIG.MAX_SAME_POOL_COST;
        
        if (CONFIG.SIMULATION_MODE) {
          // 模拟配对
          state.takerFilled += totalUnpaired;
          state.takerCost += totalUnpaired * takerPrice;
          state.firstUnpairedTime = 0;
          
          // 更新每个 slot 的 pairedFilled
          for (const slot of state.slots) {
            slot.pairedFilled = slot.filled;
          }
          
          // 组合成本 = Maker均价 + Taker价
          const avgCost = avgMakerPrice + takerPrice;
          const profit = totalUnpaired * (1 - avgCost);
          
          const tag = isForced ? '⚠️ [超时强制]' : '🔗 [模拟]';
          Logger.success(`${tag} Taker配对 ${market.asset} ${takerSide.toUpperCase()} ${totalUnpaired} @ $${takerPrice.toFixed(3)}`);
          Logger.info(`   💰 配对完成! ${totalUnpaired} pairs | 组合成本 $${avgCost.toFixed(4)} | 利润 $${profit.toFixed(2)}`);
          
          // 同步到 positions
          addPosition({
            slug: market.slug,
            asset: market.asset,
            timeGroup: market.timeGroup,
            upShares: state.makerSide === 'up' ? totalUnpaired : 0,
            downShares: state.makerSide === 'down' ? totalUnpaired : 0,
            upCost: state.makerSide === 'up' ? totalUnpaired * avgMakerPrice : totalUnpaired * takerPrice,
            downCost: state.makerSide === 'down' ? totalUnpaired * avgMakerPrice : totalUnpaired * takerPrice,
            totalCost: totalUnpaired * (avgMakerPrice + takerPrice),
            timestamp: now,
            endTime: market.endTime,
          });
        } else {
          // 实盘配对
          try {
            const client = await initClient();
            const tokenId = takerSide === 'up' ? market.upTokenId : market.downTokenId;
            
            const maxAllowedPrice = isForced
              ? Math.min(takerPrice + 0.02, 1.0 - avgMakerPrice)
              : Math.min(takerPrice + 0.01, CONFIG.MAX_SAME_POOL_COST - avgMakerPrice - 0.001);
            
            const orderArgs = {
              side: Side.BUY,
              tokenID: tokenId,
              amount: totalUnpaired * maxAllowedPrice,
              price: maxAllowedPrice,
            };
            
            const signedOrder = await client.createMarketOrder(orderArgs);
            const resp = await client.postOrder(signedOrder, OrderType.FOK);
            
            if (resp.success) {
              state.takerFilled += totalUnpaired;
              state.takerCost += totalUnpaired * takerPrice;
              state.firstUnpairedTime = 0;
              
              for (const slot of state.slots) {
                slot.pairedFilled = slot.filled;
              }
              
              const tag = isForced ? '⚠️ [超时强制]' : '🔗';
              Logger.success(`${tag} Taker配对 ${market.asset} ${takerSide.toUpperCase()} ${totalUnpaired} @ $${takerPrice.toFixed(3)}`);
            } else {
              Logger.warning(`⚠️ Taker配对未成交，等待重试...`);
            }
          } catch (error) {
            Logger.error(`Taker配对失败: ${error}`);
          }
        }
      } else {
        const waitingSec = Math.floor(waitingTime / 1000);
        const timeoutSec = Math.floor(PAIRING_TIMEOUT_MS / 1000);
        if (shouldLog) {
          Logger.warning(`⚠️ ${market.asset} 等待配对: ${takerSide} $${takerPrice.toFixed(3)} 太贵 (组合 $${combinedCost.toFixed(3)}) [${waitingSec}/${timeoutSec}秒]`);
        }
      }
      
      continue; // 先处理配对
    }
    
    // ========== 步骤3：决定挂单方向 ==========
    const makerSide = state.slots.length > 0 ? state.makerSide : decideMakerSide(upBook.bestAsk, downBook.bestAsk);
    const takerBook = makerSide === 'up' ? downBook : upBook;
    
    // 计算目标价格（核心：基于对面价格倒推）
    const targetPrice = Math.round((CONFIG.MAX_SAME_POOL_COST - takerBook.bestAsk - SAFETY_MARGIN) * 100) / 100;
    
    // ========== 步骤4：检查现有挂单 ==========
    const hasPendingOrders = state.slots.some(s => s.shares - s.filled > 0);
    const hasPartialFill = state.slots.some(s => s.filled > 0);
    
    if (hasPendingOrders) {
      const orderAge = (now - state.lastUpdate) / 1000;
      const currentOrderPrice = state.slots[0]?.price || 0;
      
      // 核心逻辑：部分成交后绝不撤单！
      if (hasPartialFill) {
        continue; // 有成交，耐心等待更多成交或配对
      }
      
      // 只有能挂更低价格时才撤单（市场对我们有利了）
      const canImprove = targetPrice < currentOrderPrice - PRICE_IMPROVE_THRESHOLD;
      
      if (canImprove && orderAge >= ORDER_CHECK_SEC) {
        Logger.info(`📉 ${market.asset} 发现更低价格: $${currentOrderPrice.toFixed(2)} → $${targetPrice.toFixed(2)} (省 $${(currentOrderPrice - targetPrice).toFixed(2)})`);
        
        // 撤销旧单
        if (!CONFIG.SIMULATION_MODE) {
          const client = await initClient();
          for (const slot of state.slots) {
            if (slot.orderId) {
              try { await client.cancelOrder({ orderID: slot.orderId }); } catch (e) {}
            }
          }
        }
        state.slots = [];
        // 继续下面的挂单逻辑
      } else {
        // 挂单有效，继续等待被吃
        if (shouldLog && orderAge > 30) {
          Logger.info(`⏳ ${market.asset} 等待成交: ${state.slots[0]?.shares} @ $${currentOrderPrice.toFixed(2)} (已挂 ${orderAge.toFixed(0)}秒)`);
          lastLogTime = now;
        }
        continue;
      }
    } else if (state.slots.length > 0) {
      // 所有挂单已完成，清空
      state.slots = [];
    }
    
    // ========== 步骤5：检查仓位限制 ==========
    const currentInvestment = stats.totalMakerCost + state.takerCost;
    if (currentInvestment >= CONFIG.MAX_EVENT_INVESTMENT_USD) {
      if (shouldLog) {
        Logger.info(`📊 ${market.asset} 已达上限: $${currentInvestment.toFixed(2)} / $${CONFIG.MAX_EVENT_INVESTMENT_USD}`);
        lastLogTime = now;
      }
      continue;
    }
    
    // ========== 步骤6：计算并挂单 ==========
    const remainingBudget = (CONFIG.MAX_EVENT_INVESTMENT_USD - currentInvestment) / 2;
    const orderBudget = Math.min(remainingBudget, CONFIG.MAKER_ORDER_SIZE_USD);
    
    const order = calculateTargetOrder(takerBook.bestAsk, orderBudget);
    
    if (!order) {
      if (shouldLog) {
        Logger.info(`⏳ ${market.asset} 无法挂单: 目标价 $${targetPrice.toFixed(2)} 超出范围`);
        lastLogTime = now;
      }
      continue;
    }
    
    // 挂单
    state.makerSide = makerSide;
    const expectedCombinedCost = order.price + takerBook.bestAsk;
    Logger.info(`📝 ${market.asset} 挂低价单: ${makerSide.toUpperCase()} ${order.shares} @ $${order.price.toFixed(3)}`);
    Logger.info(`   💰 预期组合成本: $${order.price.toFixed(2)} + $${takerBook.bestAsk.toFixed(2)} = $${expectedCombinedCost.toFixed(3)} (利润 $${(1 - expectedCombinedCost).toFixed(3)})`);
    
    if (CONFIG.SIMULATION_MODE) {
      state.slots.push({
        price: order.price,
        shares: order.shares,
        orderId: null,
        filled: 0,
        pairedFilled: 0,
        cost: 0,
      });
      state.lastUpdate = now;
    } else {
      try {
        const client = await initClient();
        const tokenId = makerSide === 'up' ? market.upTokenId : market.downTokenId;
        
        const orderArgs = {
          side: Side.BUY,
          tokenID: tokenId,
          amount: order.shares * order.price,
          price: order.price,
        };
        
        const signedOrder = await client.createMarketOrder(orderArgs);
        const resp = await client.postOrder(signedOrder, OrderType.GTC);
        
        if (resp.success && resp.orderID) {
          state.slots.push({
            price: order.price,
            shares: order.shares,
            orderId: resp.orderID,
            filled: 0,
            pairedFilled: 0,
            cost: 0,
          });
          Logger.success(`   ✅ 挂单成功，等待被吃...`);
        }
      } catch (error) {
        Logger.error(`挂单失败: ${error}`);
      }
      state.lastUpdate = now;
    }
  }
  
  if (shouldLog) {
    lastLogTime = now;
  }
};

/**
 * 检查订单状态（实盘模式）
 */
export const checkOrderStatus = async (): Promise<void> => {
  if (CONFIG.SIMULATION_MODE) return;
  
  try {
    const client = await initClient();
    
    for (const [slug, state] of marketStates) {
      for (const slot of state.slots) {
        if (!slot.orderId) continue;
        
        const pending = slot.shares - slot.filled;
        if (pending <= 0) continue;
        
        try {
          const orderStatus = await client.getOrder(slot.orderId);
          
          if (orderStatus) {
            const filledSize = parseFloat(orderStatus.size_matched || '0');
            const newFilled = filledSize - slot.filled;
            
            if (newFilled > 0) {
              slot.filled = filledSize;
              slot.cost += newFilled * slot.price;
              
              Logger.success(`📗 Maker成交 ${newFilled} @ $${slot.price.toFixed(3)} (总 ${slot.filled})`);
            }
            
            // 订单完成或取消
            if (orderStatus.status === 'MATCHED' || orderStatus.status === 'CANCELED') {
              slot.orderId = null;
            }
          }
        } catch (error) {
          // 忽略单个订单检查错误
        }
      }
    }
  } catch (error) {
    Logger.error(`检查订单状态失败: ${error}`);
  }
};

/**
 * 获取挂单统计
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
  let pendingPairs = 0;
  
  for (const [_, state] of marketStates) {
    const stats = getStateStats(state);
    
    if (state.makerSide === 'up') {
      totalUp += stats.totalMakerFilled;
      totalUpCost += stats.totalMakerCost;
      totalDown += state.takerFilled;
      totalDownCost += state.takerCost;
    } else {
      totalDown += stats.totalMakerFilled;
      totalDownCost += stats.totalMakerCost;
      totalUp += state.takerFilled;
      totalUpCost += state.takerCost;
    }
    pendingPairs += stats.totalUnpaired;
  }
  
  const pairs = Math.min(totalUp, totalDown);
  const avgCost = pairs > 0 
    ? (totalUpCost / totalUp + totalDownCost / totalDown)
    : 0;
  
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
 * 取消所有挂单（退出时调用）
 */
export const cancelAllOrders = async (): Promise<void> => {
  if (CONFIG.SIMULATION_MODE) {
    Logger.info('模拟模式，无需取消订单');
    return;
  }
  
  try {
    const client = await initClient();
    
    for (const [slug, state] of marketStates) {
      for (const slot of state.slots) {
        if (slot.orderId && slot.shares - slot.filled > 0) {
          try {
            await client.cancelOrder({ orderID: slot.orderId });
            Logger.info(`已取消订单: ${slot.orderId}`);
          } catch (e) {
            // 忽略取消失败
          }
        }
      }
    }
    
    Logger.success('所有挂单已取消');
  } catch (error) {
    Logger.error(`取消订单失败: ${error}`);
  }
};
