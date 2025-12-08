import axios from 'axios';
import CONFIG from './config';
import Logger from './logger';
import { subscribeToMarkets, getOrderBook, getActiveBookCount } from './orderbook-ws';

// 市场信息缓存
interface MarketInfo {
  slug: string;
  title: string;
  upTokenId: string;
  downTokenId: string;
  endTime: Date;
  timeGroup: '15min' | '1hr';
  asset: 'BTC' | 'ETH';
}

let cachedMarkets: MarketInfo[] = [];
let lastFetchTime = 0;
const CACHE_DURATION = 5 * 60 * 1000; // 5分钟缓存

// 套利机会（支持同池和跨池）
export interface ArbitrageOpportunity {
  type: 'same_pool' | 'cross_pool';   // 套利类型
  timeGroup: '15min' | '1hr';
  
  // Up 来源
  upMarket: MarketInfo;
  upAskPrice: number;
  upDepth: number;
  
  // Down 来源
  downMarket: MarketInfo;
  downAskPrice: number;
  downDepth: number;
  
  combinedCost: number;      // Up + Down 总成本
  profitPercent: number;     // 套利利润率
  maxShares: number;         // 最大可配对数量
}

// 生成市场 slug
const generateMarketSlugs = (): string[] => {
  const now = new Date();
  
  // 转换为美东时间 (UTC-5)
  const etOffset = -5 * 60;
  const localOffset = now.getTimezoneOffset();
  const etTime = new Date(now.getTime() + (localOffset + etOffset) * 60 * 1000);
  
  const year = etTime.getFullYear();
  const month = etTime.getMonth();
  const day = etTime.getDate();
  const hour = etTime.getHours();
  const minute = etTime.getMinutes();
  
  const slugs: string[] = [];
  
  // 15分钟场
  if (CONFIG.ENABLE_15MIN) {
    let slot15 = Math.ceil((minute + 1) / 15) * 15;
    let hour15 = hour;
    let day15 = day;
    
    if (slot15 >= 60) {
      slot15 = 0;
      hour15++;
      if (hour15 >= 24) {
        hour15 = 0;
        day15++;
      }
    }
    
    const end15 = new Date(year, month, day15, hour15, slot15, 0);
    const timestamp15 = Math.floor(end15.getTime() / 1000);
    
    slugs.push(`btc-updown-15m-${timestamp15}`);
    slugs.push(`eth-updown-15m-${timestamp15}`);
  }
  
  // 1小时场
  if (CONFIG.ENABLE_1HR) {
    let nextHour = hour + 1;
    let day1h = day;
    
    if (nextHour >= 24) {
      nextHour = 0;
      day1h++;
    }
    
    const end1h = new Date(year, month, day1h, nextHour, 0, 0);
    
    const monthNames = ['january', 'february', 'march', 'april', 'may', 'june',
                       'july', 'august', 'september', 'october', 'november', 'december'];
    const monthName = monthNames[end1h.getMonth()];
    const dayNum = end1h.getDate();
    const hourNum = end1h.getHours();
    const ampm = hourNum >= 12 ? 'pm' : 'am';
    const hour12 = hourNum === 0 ? 12 : (hourNum > 12 ? hourNum - 12 : hourNum);
    
    const dateStr = `${monthName}-${dayNum}-${hour12}${ampm}-et`;
    
    slugs.push(`bitcoin-up-or-down-${dateStr}`);
    slugs.push(`ethereum-up-or-down-${dateStr}`);
  }
  
  return slugs;
};

// 获取市场信息
const fetchMarketInfo = async (slug: string): Promise<MarketInfo | null> => {
  try {
    const response = await axios.get(`${CONFIG.POLYMARKET_API}/markets?slug=${slug}`, {
      timeout: 5000,
    });
    
    const markets = response.data;
    if (!markets || markets.length === 0) return null;
    
    const market = markets[0];
    
    let tokens = market.tokens;
    if (typeof tokens === 'string') {
      tokens = JSON.parse(tokens);
    }
    
    const upToken = tokens?.find((t: any) => 
      t.outcome?.toLowerCase() === 'up' || t.outcome?.toLowerCase() === 'yes'
    );
    const downToken = tokens?.find((t: any) => 
      t.outcome?.toLowerCase() === 'down' || t.outcome?.toLowerCase() === 'no'
    );
    
    if (!upToken || !downToken) return null;
    
    const is15min = slug.includes('15m') || slug.includes('15min');
    const isBtc = slug.includes('btc') || slug.includes('bitcoin');
    
    return {
      slug: market.slug || slug,
      title: market.question || market.title || slug,
      upTokenId: upToken.token_id,
      downTokenId: downToken.token_id,
      endTime: new Date(market.endDateIso || market.end_date_iso),
      timeGroup: is15min ? '15min' : '1hr',
      asset: isBtc ? 'BTC' : 'ETH',
    };
  } catch (error) {
    return null;
  }
};

// 刷新市场缓存
export const refreshMarkets = async (): Promise<MarketInfo[]> => {
  const now = Date.now();
  
  if (cachedMarkets.length > 0 && now - lastFetchTime < CACHE_DURATION) {
    const hasExpired = cachedMarkets.some(m => m.endTime.getTime() < now);
    if (!hasExpired) {
      return cachedMarkets;
    }
  }
  
  const slugs = generateMarketSlugs();
  const markets: MarketInfo[] = [];
  
  for (const slug of slugs) {
    const market = await fetchMarketInfo(slug);
    if (market && market.endTime.getTime() > now) {
      markets.push(market);
    }
  }
  
  if (markets.length > 0) {
    cachedMarkets = markets;
    lastFetchTime = now;
    
    subscribeToMarkets(markets.map(m => ({
      slug: m.slug,
      upTokenId: m.upTokenId,
      downTokenId: m.downTokenId,
    })));
    
    Logger.info(`已加载 ${markets.length} 个市场: ${markets.map(m => `${m.asset} ${m.timeGroup}`).join(', ')}`);
  }
  
  return cachedMarkets;
};

// 扫描所有套利机会（同池 + 跨池）
export const scanArbitrageOpportunities = async (): Promise<ArbitrageOpportunity[]> => {
  const markets = await refreshMarkets();
  const opportunities: ArbitrageOpportunity[] = [];
  
  // 按时间组分组
  const byTimeGroup: { [key: string]: MarketInfo[] } = {};
  for (const market of markets) {
    if (!byTimeGroup[market.timeGroup]) {
      byTimeGroup[market.timeGroup] = [];
    }
    byTimeGroup[market.timeGroup].push(market);
  }
  
  // 对每个时间组分析套利机会
  for (const [timeGroup, groupMarkets] of Object.entries(byTimeGroup)) {
    // 获取每个市场的订单簿数据
    const marketData: Array<{
      market: MarketInfo;
      upAsk: number;
      upDepth: number;
      downAsk: number;
      downDepth: number;
    }> = [];
    
    for (const market of groupMarkets) {
      const upBook = getOrderBook(market.upTokenId);
      const downBook = getOrderBook(market.downTokenId);
      
      if (!upBook || !downBook) continue;
      
      const upAsk = upBook.bestAsk;
      const downAsk = downBook.bestAsk;
      
      if (upAsk <= 0 || upAsk >= 1 || downAsk <= 0 || downAsk >= 1) continue;
      if (upBook.bestAskSize < 1 || downBook.bestAskSize < 1) continue;
      
      marketData.push({
        market,
        upAsk,
        upDepth: upBook.bestAskSize,
        downAsk,
        downDepth: downBook.bestAskSize,
      });
    }
    
    if (marketData.length === 0) continue;
    
    // 1. 检查同池套利机会
    for (const data of marketData) {
      const combinedCost = data.upAsk + data.downAsk;
      
      if (combinedCost < CONFIG.MAX_SAME_POOL_COST) {
        opportunities.push({
          type: 'same_pool',
          timeGroup: timeGroup as '15min' | '1hr',
          upMarket: data.market,
          upAskPrice: data.upAsk,
          upDepth: data.upDepth,
          downMarket: data.market,
          downAskPrice: data.downAsk,
          downDepth: data.downDepth,
          combinedCost,
          profitPercent: (1 - combinedCost) * 100,
          maxShares: Math.min(data.upDepth, data.downDepth),
        });
      }
    }
    
    // 2. 检查跨池套利机会（如果有多个市场）
    if (marketData.length >= 2) {
      // 找最便宜的 Up 和最便宜的 Down
      let cheapestUp = marketData[0];
      let cheapestDown = marketData[0];
      
      for (const data of marketData) {
        if (data.upAsk < cheapestUp.upAsk) {
          cheapestUp = data;
        }
        if (data.downAsk < cheapestDown.downAsk) {
          cheapestDown = data;
        }
      }
      
      // 如果来自不同市场，就是跨池套利
      if (cheapestUp.market.asset !== cheapestDown.market.asset) {
        const combinedCost = cheapestUp.upAsk + cheapestDown.downAsk;
        
        if (combinedCost < CONFIG.MAX_SAME_POOL_COST) {
          opportunities.push({
            type: 'cross_pool',
            timeGroup: timeGroup as '15min' | '1hr',
            upMarket: cheapestUp.market,
            upAskPrice: cheapestUp.upAsk,
            upDepth: cheapestUp.upDepth,
            downMarket: cheapestDown.market,
            downAskPrice: cheapestDown.downAsk,
            downDepth: cheapestDown.downDepth,
            combinedCost,
            profitPercent: (1 - combinedCost) * 100,
            maxShares: Math.min(cheapestUp.upDepth, cheapestDown.downDepth),
          });
        }
        
        // 也检查反向跨池：cheapestDown.Up + cheapestUp.Down
        const reverseUp = cheapestDown;
        const reverseDown = cheapestUp;
        const reverseCost = reverseUp.upAsk + reverseDown.downAsk;
        
        if (reverseCost < CONFIG.MAX_SAME_POOL_COST) {
          opportunities.push({
            type: 'cross_pool',
            timeGroup: timeGroup as '15min' | '1hr',
            upMarket: reverseUp.market,
            upAskPrice: reverseUp.upAsk,
            upDepth: reverseUp.upDepth,
            downMarket: reverseDown.market,
            downAskPrice: reverseDown.downAsk,
            downDepth: reverseDown.downDepth,
            combinedCost: reverseCost,
            profitPercent: (1 - reverseCost) * 100,
            maxShares: Math.min(reverseUp.upDepth, reverseDown.downDepth),
          });
        }
      }
    }
  }
  
  // 按利润率排序（优先执行利润最高的）
  opportunities.sort((a, b) => b.profitPercent - a.profitPercent);
  
  return opportunities;
};

export const getMarkets = (): MarketInfo[] => {
  return cachedMarkets;
};

export { getActiveBookCount };
