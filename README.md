# 🎯 Polymarket 套利机器人 V2

## 核心策略：同池优先 + 跨池优化

基于对成功交易员的数据分析，本机器人采用混合策略：

### 1. 同池套利（无风险）
```
BTC 池: 买 BTC Up + BTC Down
ETH 池: 买 ETH Up + ETH Down

当 Up + Down < $1.00 时买入，无论涨跌都赚钱！
```

### 2. 跨池优化（高利润）
```
跨池组合: 买 BTC Up + ETH Down (或反向)

当跨池成本更低时，优先选择跨池组合获取更高利润
```

## 策略来源

分析交易员数据发现：
```
BTC 同池成本: $0.976 (利润 2.4%)
ETH 同池成本: $0.992 (利润 0.8%)
BTC↑+ETH↓ 跨池成本: $0.866 (利润 13.36%) ← 更便宜！
```

他的策略是：**优先选择成本最低的组合**，无论是同池还是跨池。

## 快速开始

```bash
# 1. 安装依赖
npm install

# 2. 配置
npm run setup

# 3. 运行
npm run dev
```

## 配置说明

| 参数 | 说明 | 默认值 |
|------|------|--------|
| MAX_SAME_POOL_COST | 最大成本阈值 | 0.995 |
| MAX_ORDER_SIZE_USD | 单笔订单上限 | $10 |
| TRADE_COOLDOWN_MS | 交易冷却时间 | 2000ms |
| ENABLE_15MIN | 15分钟场开关 | 开启 |
| ENABLE_1HR | 1小时场开关 | 开启 |

## 执行逻辑

1. **扫描所有机会**：
   - 同池机会：BTC Up+Down, ETH Up+Down
   - 跨池机会：BTC↑+ETH↓, ETH↑+BTC↓

2. **按利润率排序**：
   - 优先执行利润最高的机会
   - 可能是同池，也可能是跨池

3. **仓位管理**：
   - 分别记录每个市场的 Up/Down 仓位
   - 显示整体平衡情况

## 风险说明

| 类型 | 风险 | 说明 |
|------|------|------|
| 同池套利 | ✅ 零风险 | 同一市场的 Up+Down，无论结果都赚 |
| 跨池套利 | ⚠️ 有风险 | BTC/ETH 方向不一致时可能亏损 |

**跨池风险概率**（基于半年数据分析）：
- BTC/ETH 同向概率：80.3%
- BTC/ETH 反向概率：19.7%
- 双输概率：~10%

## 文件结构

```
src/
├── index.ts          # 主入口
├── config.ts         # 配置
├── scanner.ts        # 扫描套利机会（同池+跨池）
├── executor.ts       # 执行交易
├── positions.ts      # 仓位管理
├── orderbook-ws.ts   # WebSocket 订单簿
├── telegram.ts       # Telegram 通知
├── client.ts         # Polymarket 客户端
├── logger.ts         # 日志
└── setup.ts          # 配置向导
```

## 许可证

MIT
