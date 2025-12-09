import dotenv from 'dotenv';
dotenv.config();

export const CONFIG = {
  // ========== 钱包配置 ==========
  PRIVATE_KEY: process.env.PRIVATE_KEY || '',
  PROXY_WALLET: process.env.PROXY_WALLET || '',
  
  // ========== Telegram 配置 ==========
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || '',
  TELEGRAM_GROUP_ID: process.env.TELEGRAM_GROUP_ID || '',
  
  // ========== 模式 ==========
  SIMULATION_MODE: process.env.SIMULATION_MODE !== 'false',
  
  // ========== 核心参数 ==========
  // 最大组合成本阈值 (Up + Down 必须小于此值才交易)
  MAX_SAME_POOL_COST: parseFloat(process.env.MAX_SAME_POOL_COST || '0.995'),
  
  // 单轮挂单金额 (USD) - 会分布到多个价格档
  MAKER_ORDER_SIZE_USD: parseFloat(process.env.MAKER_ORDER_SIZE_USD || '15'),
  
  // 单事件最大投入 (USD) - 风控上限
  MAX_EVENT_INVESTMENT_USD: parseFloat(process.env.MAX_EVENT_INVESTMENT_USD || '5000'),
  
  // 配对超时时间 (秒) - 超时后接受更高价格配对
  PAIRING_TIMEOUT_SEC: parseInt(process.env.PAIRING_TIMEOUT_SEC || '300'),
  
  // 扫描间隔 (毫秒)
  SCAN_INTERVAL_MS: 100,
  
  // ========== 市场开关 ==========
  ENABLE_15MIN: process.env.ENABLE_15MIN !== '0',
  ENABLE_1HR: process.env.ENABLE_1HR === '1',
  
  // ========== API ==========
  POLYMARKET_API: 'https://gamma-api.polymarket.com',
  CLOB_API: 'https://clob.polymarket.com',
  WS_URL: 'wss://ws-subscriptions-clob.polymarket.com/ws/market',
  CHAIN_ID: 137,
};

export default CONFIG;

