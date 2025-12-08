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

// 订阅的资产列表
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
    return; // 无需重新订阅
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
      Logger.success(`WebSocket 连接成功，订阅 ${tokenIds.length} 个 tokens`);
      
      // 订阅所有 token
      tokenIds.forEach(tokenId => {
        const subscribeMsg = {
          type: 'market',
          assets_ids: [tokenId],
        };
        ws?.send(JSON.stringify(subscribeMsg));
      });
    });

    ws.on('message', (data: WebSocket.Data) => {
      try {
        const msg = JSON.parse(data.toString());
        
        if (msg.event_type === 'book') {
          processBookUpdate(msg);
        }
      } catch (e) {
        // 忽略解析错误
      }
    });

    ws.on('close', () => {
      isConnected = false;
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
    Logger.info('重新连接 WebSocket...');
    connectWebSocket(tokenIds);
  }, 5000);
};

const processBookUpdate = (msg: any) => {
  const tokenId = msg.asset_id;
  if (!tokenId) return;

  const bids = msg.bids || [];
  const asks = msg.asks || [];

  // 找最佳买卖价
  let bestBid = 0;
  let bestBidSize = 0;
  let bestAsk = 1;
  let bestAskSize = 0;

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
  bidPrices.forEach((size, price) => {
    if (price > bestBid) {
      bestBid = price;
      bestBidSize = size;
    }
  });

  // 找最低卖价
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
  return orderBooks.get(tokenId) || null;
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
