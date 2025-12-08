import { Side, OrderType } from '@polymarket/clob-client';
import CONFIG from './config';
import Logger from './logger';
import { initClient } from './client';
import { ArbitrageOpportunity } from './scanner';
import { addPosition } from './positions';

// 上次交易时间
let lastTradeTime = 0;

// 执行套利（同池或跨池）
export const executeArbitrage = async (
  opportunity: ArbitrageOpportunity
): Promise<{ success: boolean; upFilled: number; downFilled: number; totalCost: number }> => {
  
  // 检查冷却时间
  const now = Date.now();
  if (now - lastTradeTime < CONFIG.TRADE_COOLDOWN_MS) {
    return { success: false, upFilled: 0, downFilled: 0, totalCost: 0 };
  }
  
  const { type, timeGroup, upMarket, downMarket, upAskPrice, downAskPrice, maxShares } = opportunity;
  
  // 计算下单数量
  const maxByFunds = CONFIG.MAX_ORDER_SIZE_USD / (upAskPrice + downAskPrice);
  const shares = Math.floor(Math.min(maxShares, maxByFunds));
  
  if (shares < 1) {
    return { success: false, upFilled: 0, downFilled: 0, totalCost: 0 };
  }
  
  const upCost = shares * upAskPrice;
  const downCost = shares * downAskPrice;
  const totalCost = upCost + downCost;
  const expectedProfit = shares - totalCost;
  
  const typeTag = type === 'same_pool' ? '📊同池' : '🔀跨池';
  const pairInfo = type === 'same_pool' 
    ? upMarket.asset 
    : `${upMarket.asset}↑${downMarket.asset}↓`;
  
  Logger.info(`🎯 ${timeGroup} ${typeTag} ${pairInfo}: Up $${upAskPrice.toFixed(3)} + Down $${downAskPrice.toFixed(3)} = $${(upAskPrice + downAskPrice).toFixed(4)}`);
  
  // 模拟模式
  if (CONFIG.SIMULATION_MODE) {
    Logger.success(`[模拟] 买入 ${shares} shares | Up $${upCost.toFixed(2)} + Down $${downCost.toFixed(2)} = $${totalCost.toFixed(2)} | 利润 $${expectedProfit.toFixed(2)}`);
    
    // 记录仓位
    // Up 仓位
    addPosition({
      slug: upMarket.slug,
      asset: upMarket.asset,
      timeGroup: upMarket.timeGroup,
      upShares: shares,
      downShares: 0,
      upCost,
      downCost: 0,
      totalCost: upCost,
      timestamp: now,
      endTime: upMarket.endTime,
    });
    
    // Down 仓位（如果是跨池，记到另一个市场）
    addPosition({
      slug: downMarket.slug,
      asset: downMarket.asset,
      timeGroup: downMarket.timeGroup,
      upShares: 0,
      downShares: shares,
      upCost: 0,
      downCost,
      totalCost: downCost,
      timestamp: now,
      endTime: downMarket.endTime,
    });
    
    lastTradeTime = now;
    return { success: true, upFilled: shares, downFilled: shares, totalCost };
  }
  
  // 实盘模式
  try {
    const client = await initClient();
    
    // 买入 Up
    const upOrderPrice = Math.min(upAskPrice * 1.005, 0.99);
    const upAmount = shares * upOrderPrice;
    
    const upOrderArgs = {
      side: Side.BUY,
      tokenID: upMarket.upTokenId,
      amount: upAmount,
      price: upOrderPrice,
    };
    
    const upSignedOrder = await client.createMarketOrder(upOrderArgs);
    const upResp = await client.postOrder(upSignedOrder, OrderType.FOK);
    
    if (!upResp.success) {
      Logger.warning(`Up 订单未成交`);
      return { success: false, upFilled: 0, downFilled: 0, totalCost: 0 };
    }
    
    // 买入 Down
    const downOrderPrice = Math.min(downAskPrice * 1.005, 0.99);
    const downAmount = shares * downOrderPrice;
    
    const downOrderArgs = {
      side: Side.BUY,
      tokenID: downMarket.downTokenId,
      amount: downAmount,
      price: downOrderPrice,
    };
    
    const downSignedOrder = await client.createMarketOrder(downOrderArgs);
    const downResp = await client.postOrder(downSignedOrder, OrderType.FOK);
    
    if (!downResp.success) {
      Logger.warning(`Down 订单未成交，Up 已成交！`);
      // 记录单边仓位
      addPosition({
        slug: upMarket.slug,
        asset: upMarket.asset,
        timeGroup: upMarket.timeGroup,
        upShares: shares,
        downShares: 0,
        upCost: upAmount,
        downCost: 0,
        totalCost: upAmount,
        timestamp: now,
        endTime: upMarket.endTime,
      });
      lastTradeTime = now;
      return { success: true, upFilled: shares, downFilled: 0, totalCost: upAmount };
    }
    
    // 两边都成交
    const realTotalCost = upAmount + downAmount;
    Logger.success(`[实盘] ${typeTag} 买入 ${shares} shares | 成本 $${realTotalCost.toFixed(2)} | 利润 $${(shares - realTotalCost).toFixed(2)}`);
    
    // 记录仓位
    addPosition({
      slug: upMarket.slug,
      asset: upMarket.asset,
      timeGroup: upMarket.timeGroup,
      upShares: shares,
      downShares: 0,
      upCost: upAmount,
      downCost: 0,
      totalCost: upAmount,
      timestamp: now,
      endTime: upMarket.endTime,
    });
    
    addPosition({
      slug: downMarket.slug,
      asset: downMarket.asset,
      timeGroup: downMarket.timeGroup,
      upShares: 0,
      downShares: shares,
      upCost: 0,
      downCost: downAmount,
      totalCost: downAmount,
      timestamp: now,
      endTime: downMarket.endTime,
    });
    
    lastTradeTime = now;
    return { success: true, upFilled: shares, downFilled: shares, totalCost: realTotalCost };
    
  } catch (error) {
    Logger.error(`下单失败: ${error}`);
    return { success: false, upFilled: 0, downFilled: 0, totalCost: 0 };
  }
};

export const getLastTradeTime = (): number => lastTradeTime;
