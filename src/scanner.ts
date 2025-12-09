import axios from 'axios';
import CONFIG from './config';
import Logger from './logger';
import { subscribeToMarkets, getOrderBook, getActiveBookCount } from './orderbook-ws';

// 市场信息缓存
interface MarketInfo {
  slug: string;
  conditionId: string;
  title: string;
  upTokenId: string;
  downTokenId: string;
  endTime: Date;
  timeGroup: '15min' | '1hr';
  asset: 'BTC' | 'ETH';
}

let cachedMarkets: MarketInfo[] = [];
let lastFetchTime = 0;
let lastSlugs: string[] = [];
const CACHE_DURATION = 5 * 60 * 1000; // 5分钟缓存

// 套利机会
export interface ArbitrageOpportunity {
  type: 'same_pool' | 'cross_pool';
  timeGroup: '15min' | '1hr';
  upMarket: MarketInfo;
  upAskPrice: number;
  upDepth: number;
  downMarket: MarketInfo;
  downAskPrice: number;
  downDepth: number;
  combinedCost: number;
  profitPercent: number;
  maxShares: number;
}

/**
 * 生成市场 slug（与旧项目保持一致）
 */
const generateMarketSlugs = (): string[] => {
  const nowMs = Date.now();
  const etMs = nowMs - 5 * 3600 * 1000;  // ET = UTC - 5
  const etDate = new Date(etMs);
  
  const month = etDate.toLocaleString('en-US', { month: 'long', timeZone: 'UTC' }).toLowerCase();
  const day = etDate.getUTCDate();
  const hour = etDate.getUTCHours();
  const minute = etDate.getUTCMinutes();
  
  const slugs: string[] = [];
  
  // 1小时市场
  if (CONFIG.ENABLE_1HR) {
    const h12 = hour % 12 || 12;
    const ampm = hour >= 12 ? 'pm' : 'am';
    slugs.push(`bitcoin-up-or-down-${month}-${day}-${h12}${ampm}-et`);
    slugs.push(`ethereum-up-or-down-${month}-${day}-${h12}${ampm}-et`);
  }
  
  // 15分钟市场
  if (CONFIG.ENABLE_15MIN) {
    const min15Start = Math.floor(minute / 15) * 15;
    const startEt = new Date(etDate);
    startEt.setUTCMinutes(min15Start, 0, 0);
    const timestamp = Math.floor((startEt.getTime() + 5 * 3600 * 1000) / 1000);
    
    slugs.push(`btc-updown-15m-${timestamp}`);
    slugs.push(`eth-updown-15m-${timestamp}`);
  }
  
  return slugs;
};

/**
 * 通过 slug 从 gamma-api 获取 event 和 market 信息
 */
const fetchEventBySlug = async (slug: string): Promise<MarketInfo | null> => {
  try {
    // 使用 /events 接口
    const resp = await axios.get(`${CONFIG.POLYMARKET_API}/events`, {
      params: { slug },
      timeout: 10000,
    });
    
    const events = resp.data;
    if (!events || !Array.isArray(events) || events.length === 0) {
      Logger.warning(`   ⚠️ ${slug} - 事件不存在`);
      return null;
    }
    
    const event = events[0];
    const markets = event.markets;
    
    if (!markets || !Array.isArray(markets) || markets.length === 0) {
      Logger.warning(`   ⚠️ ${slug} - 没有市场数据`);
      return null;
    }
    
    // 找到有 Up/Down tokens 的 market
    for (const market of markets) {
      let outcomes = market.outcomes;
      let clobTokenIds = market.clobTokenIds;
      let outcomePrices = market.outcomePrices;
      
      // 如果是字符串，解析成数组
      if (typeof outcomes === 'string') {
        try { outcomes = JSON.parse(outcomes); } catch {}
      }
      if (typeof clobTokenIds === 'string') {
        try { clobTokenIds = JSON.parse(clobTokenIds); } catch {}
      }
      if (typeof outcomePrices === 'string') {
        try { outcomePrices = JSON.parse(outcomePrices); } catch {}
      }
      
      if (outcomes && Array.isArray(outcomes) && outcomes.length === 2) {
        const outcomeNames = outcomes.map((o: string) => o.toLowerCase());
        if (outcomeNames.includes('up') && outcomeNames.includes('down')) {
          // 检查 clobTokenIds 是否有效
          if (!clobTokenIds || !Array.isArray(clobTokenIds) || clobTokenIds.length < 2) {
            Logger.warning(`   ⚠️ ${slug} - clobTokenIds 无效`);
            return null;
          }
          
          // 构建 tokens 数组
          const tokens: Array<{ token_id: string; outcome: string; price: number }> = [];
          for (let i = 0; i < outcomes.length; i++) {
            const tokenId = String(clobTokenIds[i] || '');
            if (!tokenId) {
              Logger.warning(`   ⚠️ ${slug} - token ${i} 为空`);
              return null;
            }
            tokens.push({
              token_id: tokenId,
              outcome: outcomes[i],
              price: outcomePrices?.[i] ? parseFloat(outcomePrices[i]) : 0.5,
            });
          }
          
          // 找 Up 和 Down token
          const upToken = tokens.find(t => t.outcome.toLowerCase() === 'up');
          const downToken = tokens.find(t => t.outcome.toLowerCase() === 'down');
          
          if (!upToken || !downToken) {
            return null;
          }
          
          // 计算结束时间
          let endDateIso = market.endDateIso || market.endDate || event.endDate;
          
          // 15分钟市场：slug 包含时间戳
          const timestampMatch = slug.match(/(\d{10})$/);
          if (timestampMatch) {
            const startTimestamp = parseInt(timestampMatch[1]);
            const endTimestamp = startTimestamp + 15 * 60;
            endDateIso = new Date(endTimestamp * 1000).toISOString();
          }
          
          // 1小时市场：从 slug 解析小时
          const hourMatch = slug.match(/(\d{1,2})(am|pm)-et$/);
          if (hourMatch) {
            const nowMs = Date.now();
            const etMs = nowMs - 5 * 3600 * 1000;
            const etDate = new Date(etMs);
            
            let hourNum = parseInt(hourMatch[1]);
            const isPM = hourMatch[2] === 'pm';
            if (isPM && hourNum !== 12) hourNum += 12;
            if (!isPM && hourNum === 12) hourNum = 0;
            
            etDate.setUTCHours(hourNum + 1, 0, 0, 0);
            const endTimestamp = etDate.getTime() + 5 * 3600 * 1000;
            endDateIso = new Date(endTimestamp).toISOString();
          }
          
          const is15min = slug.includes('15m');
          const isBtc = slug.includes('btc') || slug.includes('bitcoin');
          
          return {
            slug: slug,
            conditionId: market.conditionId,
            title: market.question || event.title,
            upTokenId: upToken.token_id,
            downTokenId: downToken.token_id,
            endTime: new Date(endDateIso),
            timeGroup: is15min ? '15min' : '1hr',
            asset: isBtc ? 'BTC' : 'ETH',
          };
        }
      }
    }
    
    return null;
  } catch (error: any) {
    Logger.error(`   ❌ ${slug} - 请求失败: ${error.message}`);
    return null;
  }
};

// 刷新市场缓存
export const refreshMarkets = async (): Promise<MarketInfo[]> => {
  const now = Date.now();
  
  // 生成当前 slug
  const currentSlugs = generateMarketSlugs();
  
  // 检查 slug 是否变化
  const slugsChanged = lastSlugs.length === 0 || 
    currentSlugs.some((slug, i) => slug !== lastSlugs[i]);
  
  // 如果 slug 没变且缓存未过期，直接返回
  if (!slugsChanged && cachedMarkets.length > 0 && (now - lastFetchTime) < CACHE_DURATION) {
    return cachedMarkets;
  }
  
  // slug 变化了
  if (slugsChanged && lastSlugs.length > 0) {
    Logger.info(`🔄 检测到事件切换，更新市场订阅...`);
  }
  
  Logger.info(`📡 获取市场: ${currentSlugs.join(', ')}`);
  
  // 并行获取所有市场
  const results = await Promise.all(currentSlugs.map(slug => fetchEventBySlug(slug)));
  
  // 检查是否有市场获取失败
  const failedCount = results.filter(r => r === null).length;
  if (failedCount > 0) {
    Logger.warning(`   ⚠️ ${failedCount} 个市场获取失败，5秒后重试...`);
    
    await new Promise(r => setTimeout(r, 5000));
    const retryResults = await Promise.all(currentSlugs.map(slug => fetchEventBySlug(slug)));
    
    for (let i = 0; i < results.length; i++) {
      if (results[i] === null && retryResults[i] !== null) {
        results[i] = retryResults[i];
      }
    }
  }
  
  // 过滤有效市场
  const markets = results.filter((m): m is MarketInfo => m !== null);
  
  if (markets.length > 0) {
    cachedMarkets = markets;
    lastFetchTime = now;
    lastSlugs = currentSlugs;
    
    // 订阅 WebSocket
    subscribeToMarkets(markets.map(m => ({
      slug: m.slug,
      upTokenId: m.upTokenId,
      downTokenId: m.downTokenId,
    })));
    
    Logger.success(`✅ 找到 ${markets.length} 个市场: ${markets.map(m => `${m.asset} ${m.timeGroup}`).join(', ')}`);
  } else {
    Logger.warning('⚠️ 未找到任何有效市场');
  }
  
  return cachedMarkets;
};

// 扫描所有套利机会
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
    const marketData: Array<{
      market: MarketInfo;
      upAsk: number;
      upBid: number;
      upDepth: number;
      downAsk: number;
      downBid: number;
      downDepth: number;
    }> = [];
    
    for (const market of groupMarkets) {
      const upBook = getOrderBook(market.upTokenId);
      const downBook = getOrderBook(market.downTokenId);
      
      if (!upBook || !downBook) continue;
      
      const upAsk = upBook.bestAsk;
      const downAsk = downBook.bestAsk;
      const upBid = upBook.bestBid;
      const downBid = downBook.bestBid;
      
      if (upAsk <= 0 || upAsk >= 1 || downAsk <= 0 || downAsk >= 1) continue;
      if (upBook.bestAskSize < 1 || downBook.bestAskSize < 1) continue;
      
      marketData.push({
        market,
        upAsk,
        upBid,
        upDepth: upBook.bestAskSize,
        downAsk,
        downBid,
        downDepth: downBook.bestAskSize,
      });
    }
    
    if (marketData.length === 0) continue;
    
    // 1. 同池套利
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
    
  }
  
  opportunities.sort((a, b) => b.profitPercent - a.profitPercent);
  return opportunities;
};

export const getMarkets = (): MarketInfo[] => cachedMarkets;
export { getActiveBookCount };

