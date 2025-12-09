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
  console.log('  📝 策略: 动态吃单 + 总成本控制');
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
  
  // 核心参数
  console.log('\n━━━ 核心参数 ━━━');
  const maxCost = await question('最大组合成本 (avgUp+avgDown < 此值) [0.985]: ') || '0.985';
  const orderSize = await question('单次吃单金额/上限 (USD) [20]: ') || '20';
  const maxInvestment = await question('单事件最大投入 (USD) [5000]: ') || '5000';
  
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

# 最大不平衡比例 (按时长分组，基于实际交易数据分析)
MAX_IMBALANCE_RATIO_15MIN=${maxImbalance15min}  # 15分钟场 (实际最大12.5%)
MAX_IMBALANCE_RATIO_1HR=${maxImbalance1hr}      # 1小时场 (实际最大1.3%)

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
  console.log(`   最大组合成本: $${maxCost}`);
  console.log(`   单次吃单上限: $${orderSize}`);
  console.log(`   单事件上限: $${maxInvestment}`);
  console.log(`   15分钟场: ${enable15min === '1' ? '✅' : '❌'}`);
  console.log(`   1小时场: ${enable1hr === '1' ? '✅' : '❌'}`);
  console.log('\n📌 策略说明:');
  console.log('   1. 扫描订单簿，计算当前持仓平均成本');
  console.log('   2. 如果 avgCost + newPrice < 0.985，立即吃单');
  console.log('   3. 不限制不平衡，只看组合成本（期望值为正）');
  console.log('   4. 持有到结算，不卖出');
  console.log('\n运行 npm run dev 启动机器人\n');
  
  rl.close();
};

setup().catch(error => {
  console.error('配置出错:', error);
  rl.close();
  process.exit(1);
});
