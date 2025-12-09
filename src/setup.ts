import * as readline from 'readline';
import * as fs from 'fs';
import * as path from 'path';

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

const question = (prompt: string): Promise<string> => {
  return new Promise(resolve => {
    rl.question(prompt, answer => resolve(answer.trim()));
  });
};

const setup = async () => {
  console.log('\n');
  console.log('═'.repeat(60));
  console.log('  🎯 套利机器人 - 配置向导');
  console.log('  📝 策略: 混合模式 (Taker+Maker) / 网格模式');
  console.log('═'.repeat(60));
  console.log('\n');
  
  // 读取现有配置
  const envPath = path.join(__dirname, '..', '.env');
  let existingEnv: { [key: string]: string } = {};
  
  if (fs.existsSync(envPath)) {
    const content = fs.readFileSync(envPath, 'utf-8');
    content.split('\n').forEach(line => {
      const match = line.match(/^([^#=]+)=(.*)$/);
      if (match) {
        existingEnv[match[1].trim()] = match[2].trim();
      }
    });
  }
  
  console.log('📋 请配置以下参数 (直接回车使用默认值)\n');
  
  // 钱包配置
  console.log('━━━ 钱包配置 ━━━');
  const privateKey = await question(`私钥 [${existingEnv.PRIVATE_KEY ? '已配置' : '未配置'}]: `) || existingEnv.PRIVATE_KEY || '';
  const proxyWallet = await question(`代理钱包地址 (没有直接回车) [${existingEnv.PROXY_WALLET || '无'}]: `) || existingEnv.PROXY_WALLET || '';
  
  // Telegram（使用默认值）
  const defaultTelegramToken = '7698365045:AAGaPd7zLHdb4Ky7Tw0NobpcRCpNKWk-648';
  const defaultTelegramGroup = '@rickyhutest';
  const telegramToken = existingEnv.TELEGRAM_BOT_TOKEN || defaultTelegramToken;
  const telegramGroup = existingEnv.TELEGRAM_GROUP_ID || defaultTelegramGroup;
  
  // 模式选择
  console.log('\n━━━ 运行模式 ━━━');
  const simMode = await question('模拟模式? (1=模拟, 0=实盘) [1]: ') || '1';
  const simulationMode = simMode !== '0';
  
  // 策略选择
  console.log('\n━━━ 策略模式 ━━━');
  console.log('  1. 混合模式 (Taker主动吃单 + Maker挂单配对)');
  console.log('  2. 网格模式 (开盘挂满网格，被动等待成交)');
  const strategyMode = await question('选择策略 (1=混合, 2=网格) [1]: ') || '1';
  const isGridMode = strategyMode === '2';
  
  // 核心参数
  console.log('\n━━━ 核心参数 ━━━');
  const maxCost = await question('最大组合成本 (avgUp+avgDown < 此值) [0.985]: ') || '0.985';
  
  let orderSize = '20';
  let maxInvestment = '5000';
  let gridStep = '0.01';
  let gridShares = '16';
  
  if (isGridMode) {
    // 网格模式参数
    console.log('\n━━━ 网格参数 ━━━');
    gridStep = await question('网格间隔 (每档价格差) [0.01]: ') || '0.01';
    gridShares = await question('每档数量 (shares) [16]: ') || '16';
  } else {
    // 混合模式参数
    orderSize = await question('单次吃单金额/上限 (USD) [20]: ') || '20';
    maxInvestment = await question('单事件最大投入 (USD) [5000]: ') || '5000';
  }
  
  // 市场选择
  console.log('\n━━━ 市场选择 ━━━');
  const enable15min = await question('启用15分钟场? (1=是, 0=否) [1]: ') || '1';
  const enable1hr = await question('启用1小时场? (1=是, 0=否) [0]: ') || '0';
  
  // 生成配置
  const envContent = `# ========== 钱包配置 ==========
PRIVATE_KEY=${privateKey}
PROXY_WALLET=${proxyWallet}

# ========== Telegram 配置 ==========
TELEGRAM_BOT_TOKEN=${telegramToken}
TELEGRAM_GROUP_ID=${telegramGroup}

# ========== 运行模式 ==========
SIMULATION_MODE=${simulationMode}

# ========== 核心参数 ==========
# 最大组合成本 (avgUp + avgDown < 此值才买入)
MAX_COMBINED_COST=${maxCost}

# 单次吃单金额/上限 (USD) - 防止单笔过大
ORDER_SIZE_USD=${orderSize}

# 单事件最大投入 (USD)
MAX_EVENT_INVESTMENT_USD=${maxInvestment}

# ========== 市场开关 ==========
ENABLE_15MIN=${enable15min === '1' ? '1' : '0'}
ENABLE_1HR=${enable1hr === '1' ? '1' : '0'}
`;

  // 写入文件
  fs.writeFileSync(envPath, envContent);
  
  console.log('\n');
  console.log('═'.repeat(60));
  console.log('  ✅ 配置完成！');
  console.log('═'.repeat(60));
  console.log('\n📝 配置摘要:');
  console.log(`   模式: ${simulationMode ? '🔵 模拟' : '🔴 实盘'}`);
  console.log(`   策略: ${isGridMode ? '🌐 震荡网格' : '🎯 Taker+Maker混合'}`);
  console.log(`   最大组合成本: $${maxCost}`);
  
  if (isGridMode) {
    console.log(`   网格间隔: ${gridStep}`);
    console.log(`   每档数量: ${gridShares} shares`);
  } else {
    console.log(`   单次吃单上限: $${orderSize}`);
    console.log(`   单事件上限: $${maxInvestment}`);
  }
  
  console.log(`   15分钟场: ${enable15min === '1' ? '✅' : '❌'}`);
  console.log(`   1小时场: ${enable1hr === '1' ? '✅' : '❌'}`);
  console.log('\n📌 策略说明:');
  
  if (isGridMode) {
    console.log('   1. 事件开盘时挂满所有网格单');
    console.log('   2. 完全被动等待市场成交');
    console.log('   3. 每档组合成本固定 = MAX_COMBINED_COST');
    console.log('   4. 持有到结算，不主动平仓');
  } else {
    console.log('   1. Taker阶段: 发现便宜价格，立即吃单成交');
    console.log('   2. Maker阶段: 自动挂配对限价单，等待成交');
    console.log('   3. 组合成本 < MAX_COMBINED_COST 为核心风控');
    console.log('   4. 持有到结算，不卖出');
  }
  
  console.log('\n运行 npm run dev 启动机器人\n');
  
  rl.close();
};

setup().catch(error => {
  console.error('配置出错:', error);
  rl.close();
  process.exit(1);
});
