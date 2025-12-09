/**
 * WebSocket 订单簿管理器
 * 
 * 使用 WebSocket 实时接收订单簿更新
 * Polymarket WebSocket: wss://ws-subscriptions-clob.polymarket.com/ws/market
 */

import WebSocket from 'ws';
import CONFIG from './config';
import Logger from './logger';

interface PriceLevel {
  price: number;
  size: number;
}

interface OrderBook {
  bestBid: number;
  bestAsk: number;
  bestBidSize: number;
  bestAskSize: number;
  // 多档深度（按价格排序）
  bids: PriceLevel[];  // 从高到低
  asks: PriceLevel[];  // 从低到高
  lastUpdate: number;
}

export type { OrderBook, PriceLevel };

// 存储每个 tokenId 的订单簿
const orderBooks: Map<string, OrderBook> = new Map();

// tokenId 到 market 信息的映射
const tokenToMarket: Map<string, { slug: string; outcome: 'up' | 'down' }> = new Map();

let ws: WebSocket | null = null;
let isConnected = false;
let reconnectTimer: NodeJS.Timeout | null = null;
let heartbeatTimer: NodeJS.Timeout | null = null;
let subscribedAssets: string[] = [];
let lastPongTime = 0;

// 心跳间隔（10秒发一次）
const HEARTBEAT_INTERVAL = 10000;

// 连接超时检测（30秒没收到pong就认为断开）
const CONNECTION_TIMEOUT = 30000;

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
      
      // 启动心跳
      startHeartbeat();
    });

    ws.on('message', (data: WebSocket.Data) => {
      // 收到任何消息都更新活跃时间
      lastPongTime = Date.now();
      
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

    ws.on('close', (code: number, reason: Buffer) => {
      isConnected = false;
      stopHeartbeat();
      
      // 解释常见关闭码
      let codeInfo = '';
      switch (code) {
        case 1000: codeInfo = '正常关闭'; break;
        case 1001: codeInfo = '端点离开'; break;
        case 1006: codeInfo = '异常关闭'; break;
        case 1008: codeInfo = '策略违规'; break;
        case 1011: codeInfo = '服务器错误'; break;
        default: codeInfo = '未知';
      }
      
      Logger.warning(`WebSocket 关闭 [${code}: ${codeInfo}]`);
      scheduleReconnect(tokenIds);
    });

    ws.on('error', (error: Error) => {
      Logger.warning(`WebSocket 错误: ${error.message}`);
    });
    
    ws.on('pong', () => {
      lastPongTime = Date.now();
    });

  } catch (error) {
    Logger.error(`WebSocket 连接失败: ${error}`);
    scheduleReconnect(tokenIds);
  }
};

const scheduleReconnect = (tokenIds: string[]) => {
  // 避免重复调度
  if (reconnectTimer) {
    return;
  }
  
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (!isConnected && tokenIds.length > 0) {
      Logger.info('🔄 重新连接 WebSocket...');
      connectWebSocket(tokenIds);
    }
  }, 3000); // 缩短到3秒
};

// 心跳保活
const startHeartbeat = () => {
  stopHeartbeat();
  lastPongTime = Date.now();
  
  heartbeatTimer = setInterval(() => {
    if (ws && isConnected) {
      try {
        // 检查是否超时（长时间没收到任何消息）
        const timeSinceLastPong = Date.now() - lastPongTime;
        if (timeSinceLastPong > CONNECTION_TIMEOUT) {
          Logger.warning(`心跳超时 ${(timeSinceLastPong / 1000).toFixed(0)}秒，重连...`);
          ws.close();
          return;
        }
        
        // 发送 WebSocket ping 帧
        ws.ping();
        
        // 同时发送 JSON ping（有些服务器需要这个）
        ws.send(JSON.stringify({ type: 'ping' }));
      } catch (e) {
        // 忽略
      }
    }
  }, HEARTBEAT_INTERVAL);
};

const stopHeartbeat = () => {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
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
    if (size > 0) {
      bidPrices.set(price, (bidPrices.get(price) || 0) + size);
    }
  });

  asks.forEach((ask: any) => {
    const price = parseFloat(ask.price);
    const size = parseFloat(ask.size);
    if (size > 0) {
      askPrices.set(price, (askPrices.get(price) || 0) + size);
    }
  });

  // 转换为数组并排序
  const bidLevels: PriceLevel[] = Array.from(bidPrices.entries())
    .map(([price, size]) => ({ price, size }))
    .sort((a, b) => b.price - a.price);  // 从高到低
  
  const askLevels: PriceLevel[] = Array.from(askPrices.entries())
    .map(([price, size]) => ({ price, size }))
    .sort((a, b) => a.price - b.price);  // 从低到高

  // 找最优价格
  const bestBid = bidLevels[0]?.price || 0;
  const bestBidSize = bidLevels[0]?.size || 0;
  const bestAsk = askLevels[0]?.price || 1;
  const bestAskSize = askLevels[0]?.size || 0;

  orderBooks.set(tokenId, {
    bestBid,
    bestAsk,
    bestBidSize,
    bestAskSize,
    bids: bidLevels.slice(0, 10),  // 保留前10档
    asks: askLevels.slice(0, 10),
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

