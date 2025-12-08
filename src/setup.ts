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
  console.log('  🎯 混合套利机器人 - 配置向导');
  console.log('  📊 策略参数基于 15000 笔交易数据分析');
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
  
  console.log('📋 请配置以下参数 (直接回车使用推荐值)\n');
  
  // 钱包配置
  console.log('━━━ 钱包配置 ━━━');
  const privateKey = await question(`私钥 [${existingEnv.PRIVATE_KEY ? '已配置' : '未配置'}]: `) || existingEnv.PRIVATE_KEY || '';
  const proxyWallet = await question(`代理钱包地址 (没有直接回车) [${existingEnv.PROXY_WALLET || '无'}]: `) || existingEnv.PROXY_WALLET || '';
  
  // 模式选择
  console.log('\n━━━ 运行模式 ━━━');
  const simMode = await question('模拟模式? (1=模拟, 0=实盘) [1]: ') || '1';
  const simulationMode = simMode !== '0';
  
  // 策略参数（基于数据分析的推荐值）
  console.log('\n━━━ 策略参数 (基于数据分析) ━━━');
  console.log('   数据来源: 15000笔交易, 100%胜率, 平均成本$0.9894');
  console.log('');
  
  const maxCombinedCost = await question('目标组合成本 (Up+Down < 此值) [0.98]: ') || '0.98';
  const takerThreshold = await question('吃单阈值 (低于此价格直接吃单) [0.48]: ') || '0.48';
  const makerOrderSize = await question('单笔交易金额 (USD) [10]: ') || '10';
  const makerMaxImbalance = await question('最大仓位失衡 (超过则强制平衡) [30]: ') || '30';
  
  // 市场选择
  console.log('\n━━━ 市场选择 ━━━');
  const enable15min = await question('启用 15 分钟场? (1=是, 0=否) [1]: ') || '1';
  const enable1hr = await question('启用 1 小时场? (1=是, 0=否) [0]: ') || '0';
  
  // 生成配置
  const envContent = `# ═══════════════════════════════════════════════════════════
# 混合套利机器人配置
# 策略参数基于 15000 笔交易数据分析（100%胜率）
# ═══════════════════════════════════════════════════════════

# ========== 钱包配置 ==========
PRIVATE_KEY=${privateKey}
PROXY_WALLET=${proxyWallet}

# ========== Telegram 配置 ==========
TELEGRAM_BOT_TOKEN=${existingEnv.TELEGRAM_BOT_TOKEN || '7698365045:AAGaPd7zLHdb4Ky7Tw0NobpcRCpNKWk-648'}
TELEGRAM_GROUP_ID=${existingEnv.TELEGRAM_GROUP_ID || '@rickyhutest'}

# ========== 运行模式 ==========
SIMULATION_MODE=${simulationMode}

# ========== 核心策略参数（基于数据分析） ==========
# 目标组合成本（数据显示66.7%事件成本在$0.95-$0.98）
MAX_COMBINED_COST=${maxCombinedCost}

# 吃单阈值：低于此价格直接吃单（0.48 + 0.50 = 0.98）
TAKER_THRESHOLD=${takerThreshold}

# ========== 市场开关 ==========
ENABLE_15MIN=${enable15min === '1' ? '1' : '0'}
ENABLE_1HR=${enable1hr === '1' ? '1' : '0'}

# ========== 交易参数 ==========
# 单笔交易金额 (USD)
MAKER_ORDER_SIZE_USD=${makerOrderSize}

# 最大仓位失衡 (超过此值会强制平衡)
MAKER_MAX_IMBALANCE=${makerMaxImbalance}

# 扫描间隔 (毫秒) - 建议 3000ms
MAKER_INTERVAL_MS=3000

# 单笔最大 shares
MAKER_MAX_SHARES_PER_ORDER=20
`;

  // 写入文件
  fs.writeFileSync(envPath, envContent);
  
  console.log('\n');
  console.log('═'.repeat(60));
  console.log('  ✅ 配置完成！');
  console.log('═'.repeat(60));
  console.log('\n📝 配置摘要:');
  console.log(`   模式: ${simulationMode ? '🔵 模拟' : '🔴 实盘'}`);
  console.log(`   目标组合成本: ≤ $${maxCombinedCost}`);
  console.log(`   吃单阈值: < $${takerThreshold}`);
  console.log(`   单笔金额: $${makerOrderSize}`);
  console.log(`   最大失衡: ${makerMaxImbalance} shares`);
  console.log(`   市场: ${enable15min === '1' ? '15分钟' : ''}${enable15min === '1' && enable1hr === '1' ? ' + ' : ''}${enable1hr === '1' ? '1小时' : ''}`);
  console.log('\n📊 策略说明:');
  console.log('   • 价格 < $0.48 → 直接吃单（抢便宜货）');
  console.log('   • Up $0.50-$0.75 / Down $0.25-$0.50 → 挂单等待');
  console.log('   • 自动平衡 Up/Down 仓位');
  console.log('\n运行 npm run dev 启动机器人\n');
  
  rl.close();
};

setup().catch(error => {
  console.error('配置出错:', error);
  rl.close();
  process.exit(1);
});
