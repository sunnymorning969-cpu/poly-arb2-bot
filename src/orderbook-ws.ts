/**
 * WebSocket 订单簿管理器
 * 
 * 使用 WebSocket 实时接收订单簿更新
 * Polymarket WebSocket: wss://ws-subscriptions-clob.polymarket.com/ws/market
 */

import WebSocket from 'ws';
import CONFIG from './config';
import Logger from './logger';

interface OrderBook {
  bestBid: number;
  bestAsk: number;
  bestBidSize: number;
  bestAskSize: number;
  lastUpdate: number;
}

// 存储每个 tokenId 的订单簿
const orderBooks: Map<string, OrderBook> = new Map();

// tokenId 到 market 信息的映射
const tokenToMarket: Map<string, { slug: string; outcome: 'up' | 'down' }> = new Map();

let ws: WebSocket | null = null;
let isConnected = false;
let reconnectTimer: NodeJS.Timeout | null = null;
let subscribedAssets: string[] = [];

export const subscribeToMarkets = (markets: Array<{ 
  slug: string; 
  upTokenId: string; 
  downTokenId: string;
}>) => {
  // 记录 token 映射
  markets.forEach(m => {
    tokenToMarket.set(m.upTokenId, { slug: m.slug, outcome: 'up' });
    tokenToMarket.set(m.downTokenId, { slug: m.slug, outcome: 'down' });
  });

  // 获取所有 tokenId
  const allTokenIds: string[] = [];
  markets.forEach(m => {
    allTokenIds.push(m.upTokenId, m.downTokenId);
  });

  // 检查是否需要重新订阅
  const newAssets = allTokenIds.sort().join(',');
  const oldAssets = subscribedAssets.sort().join(',');
  
  if (newAssets === oldAssets && isConnected) {
    return;
  }

  subscribedAssets = allTokenIds;
  
  // 关闭旧连接
  if (ws) {
    ws.close();
    ws = null;
  }

  connectWebSocket(allTokenIds);
};

const connectWebSocket = (tokenIds: string[]) => {
  if (tokenIds.length === 0) return;

  try {
    ws = new WebSocket(CONFIG.WS_URL);

    ws.on('open', () => {
      isConnected = true;
      Logger.success(`✅ WebSocket 连接成功`);
      
      // 批量订阅所有 token（一条消息）
      const subscribeMsg = {
        auth: {},
        type: 'market',
        assets_ids: tokenIds,
      };
      
      ws?.send(JSON.stringify(subscribeMsg));
      Logger.info(`📡 发送订阅请求: ${tokenIds.length} 个 token`);
    });

    ws.on('message', (data: WebSocket.Data) => {
      try {
        const parsed = JSON.parse(data.toString());
        
        // 处理数组消息（订单簿快照）
        if (Array.isArray(parsed)) {
          let bookCount = 0;
          for (const msg of parsed) {
            if (msg.event_type === 'book' && msg.asset_id) {
              processBookUpdate(msg);
              bookCount++;
            }
          }
          if (bookCount > 0) {
            Logger.info(`📗 收到 ${bookCount} 个订单簿快照`);
          }
          return;
        }
        
        // 处理单个消息
        if (parsed.event_type === 'book') {
          processBookUpdate(parsed);
        }
        
        // 处理价格变化消息
        if (parsed.price_changes && Array.isArray(parsed.price_changes)) {
          for (const change of parsed.price_changes) {
            const current = orderBooks.get(change.asset_id);
            if (current && change.price && change.size) {
              if (change.side === 'SELL') {
                current.bestAsk = parseFloat(change.price);
                current.bestAskSize = parseFloat(change.size);
              } else if (change.side === 'BUY') {
                current.bestBid = parseFloat(change.price);
                current.bestBidSize = parseFloat(change.size);
              }
              current.lastUpdate = Date.now();
            }
          }
        }
      } catch (e) {
        // 忽略解析错误
      }
    });

    ws.on('close', () => {
      isConnected = false;
      Logger.warning('WebSocket 连接关闭');
      scheduleReconnect(tokenIds);
    });

    ws.on('error', (error) => {
      Logger.warning(`WebSocket 错误: ${error.message}`);
    });

  } catch (error) {
    Logger.error(`WebSocket 连接失败: ${error}`);
    scheduleReconnect(tokenIds);
  }
};

const scheduleReconnect = (tokenIds: string[]) => {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
  }
  reconnectTimer = setTimeout(() => {
    Logger.info('🔄 重新连接 WebSocket...');
    connectWebSocket(tokenIds);
  }, 5000);
};

const processBookUpdate = (msg: any) => {
  const tokenId = msg.asset_id;
  if (!tokenId) return;

  const bids = msg.bids || [];
  const asks = msg.asks || [];

  // 聚合同价格的深度
  const bidPrices: Map<number, number> = new Map();
  const askPrices: Map<number, number> = new Map();

  bids.forEach((bid: any) => {
    const price = parseFloat(bid.price);
    const size = parseFloat(bid.size);
    bidPrices.set(price, (bidPrices.get(price) || 0) + size);
  });

  asks.forEach((ask: any) => {
    const price = parseFloat(ask.price);
    const size = parseFloat(ask.size);
    askPrices.set(price, (askPrices.get(price) || 0) + size);
  });

  // 找最高买价
  let bestBid = 0;
  let bestBidSize = 0;
  bidPrices.forEach((size, price) => {
    if (price > bestBid) {
      bestBid = price;
      bestBidSize = size;
    }
  });

  // 找最低卖价
  let bestAsk = 1;
  let bestAskSize = 0;
  askPrices.forEach((size, price) => {
    if (price < bestAsk) {
      bestAsk = price;
      bestAskSize = size;
    }
  });

  orderBooks.set(tokenId, {
    bestBid,
    bestAsk,
    bestBidSize,
    bestAskSize,
    lastUpdate: Date.now(),
  });
};

export const getOrderBook = (tokenId: string): OrderBook | null => {
  const book = orderBooks.get(tokenId);
  if (!book) return null;
  
  // 检查数据是否过期（10秒）
  if (Date.now() - book.lastUpdate > 10000) {
    return null;
  }
  
  return book;
};

export const isWebSocketConnected = (): boolean => {
  return isConnected;
};

export const getActiveBookCount = (): number => {
  const now = Date.now();
  let count = 0;
  orderBooks.forEach((book) => {
    if (now - book.lastUpdate < 30000) {
      count++;
    }
  });
  return count;
};

export const closeWebSocket = () => {
  if (ws) {
    ws.close();
    ws = null;
  }
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  isConnected = false;
};

