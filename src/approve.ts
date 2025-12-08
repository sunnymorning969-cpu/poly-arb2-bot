/**
 * 钱包授权脚本
 * 
 * 检查并授权 USDC/USDC.e 到 Polymarket 合约
 * 
 * 使用方法: npm run approve
 */

import { ethers } from 'ethers';
import CONFIG from './config';
import Logger from './logger';

// Polygon 合约地址
const CONTRACTS = {
  CTF_EXCHANGE: '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E',
  CONDITIONAL_TOKENS: '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045',
  USDC_E: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174',
  USDC: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
};

const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function symbol() view returns (string)',
];

const CT_ABI = [
  'function isApprovedForAll(address owner, address operator) view returns (bool)',
  'function setApprovalForAll(address operator, bool approved)',
];

const run = async () => {
  Logger.header('🔐 钱包授权工具');
  
  if (!CONFIG.PRIVATE_KEY) {
    Logger.error('❌ 请先配置 PRIVATE_KEY');
    Logger.info('运行 npm run setup 进行配置');
    process.exit(1);
  }
  
  const provider = new ethers.providers.JsonRpcProvider('https://polygon-rpc.com');
  const wallet = new ethers.Wallet(CONFIG.PRIVATE_KEY, provider);
  const address = CONFIG.PROXY_WALLET || wallet.address;
  
  Logger.info(`钱包地址: ${address}`);
  Logger.info(`代理钱包: ${CONFIG.PROXY_WALLET || '无'}`);
  Logger.divider();
  
  // 检查余额
  Logger.info('📊 检查余额...');
  
  const usdce = new ethers.Contract(CONTRACTS.USDC_E, ERC20_ABI, provider);
  const usdc = new ethers.Contract(CONTRACTS.USDC, ERC20_ABI, provider);
  
  const usdceBalance = await usdce.balanceOf(address);
  const usdcBalance = await usdc.balanceOf(address);
  const maticBalance = await provider.getBalance(address);
  
  Logger.info(`USDC.e: $${ethers.utils.formatUnits(usdceBalance, 6)}`);
  Logger.info(`USDC:   $${ethers.utils.formatUnits(usdcBalance, 6)}`);
  Logger.info(`MATIC:  ${ethers.utils.formatEther(maticBalance)} (用于 Gas)`);
  Logger.divider();
  
  // 检查授权
  Logger.info('🔍 检查授权状态...\n');
  
  const approvals = [
    { token: usdce, name: 'USDC.e', address: CONTRACTS.USDC_E },
    { token: usdc, name: 'USDC', address: CONTRACTS.USDC },
  ];
  
  for (const { token, name, address: tokenAddr } of approvals) {
    const allowance = await token.allowance(address, CONTRACTS.CTF_EXCHANGE);
    const allowanceNum = parseFloat(ethers.utils.formatUnits(allowance, 6));
    
    if (allowanceNum > 1000000) {
      Logger.success(`✅ ${name} -> CTF Exchange: 已授权 (无限)`);
    } else if (allowanceNum > 0) {
      Logger.warning(`⚠️ ${name} -> CTF Exchange: 已授权 $${allowanceNum.toFixed(2)}`);
    } else {
      Logger.error(`❌ ${name} -> CTF Exchange: 未授权`);
    }
  }
  
  // 检查 Conditional Tokens 授权
  const ct = new ethers.Contract(CONTRACTS.CONDITIONAL_TOKENS, CT_ABI, provider);
  const ctApproved = await ct.isApprovedForAll(address, CONTRACTS.CTF_EXCHANGE);
  
  if (ctApproved) {
    Logger.success(`✅ Conditional Tokens -> CTF Exchange: 已授权`);
  } else {
    Logger.error(`❌ Conditional Tokens -> CTF Exchange: 未授权`);
  }
  
  Logger.divider();
  
  // 询问是否授权
  const readline = await import('readline');
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  
  const question = (prompt: string): Promise<string> => {
    return new Promise(resolve => {
      rl.question(prompt, answer => resolve(answer.trim().toLowerCase()));
    });
  };
  
  const answer = await question('是否执行全部授权? (y/n): ');
  
  if (answer !== 'y' && answer !== 'yes') {
    Logger.info('已取消');
    rl.close();
    process.exit(0);
  }
  
  Logger.divider();
  Logger.info('⏳ 开始授权...\n');
  
  // 执行授权
  const walletWithProvider = wallet.connect(provider);
  
  // 授权 USDC.e
  const usdceContract = new ethers.Contract(CONTRACTS.USDC_E, ERC20_ABI, walletWithProvider);
  const usdceAllowance = await usdceContract.allowance(address, CONTRACTS.CTF_EXCHANGE);
  if (usdceAllowance.lt(ethers.utils.parseUnits('1000000', 6))) {
    Logger.info('📝 授权 USDC.e...');
    const tx1 = await usdceContract.approve(CONTRACTS.CTF_EXCHANGE, ethers.constants.MaxUint256);
    Logger.info(`   交易: ${tx1.hash}`);
    await tx1.wait();
    Logger.success('   ✅ USDC.e 授权成功!');
  }
  
  // 授权 USDC
  const usdcContract = new ethers.Contract(CONTRACTS.USDC, ERC20_ABI, walletWithProvider);
  const usdcAllowance = await usdcContract.allowance(address, CONTRACTS.CTF_EXCHANGE);
  if (usdcAllowance.lt(ethers.utils.parseUnits('1000000', 6))) {
    Logger.info('📝 授权 USDC...');
    const tx2 = await usdcContract.approve(CONTRACTS.CTF_EXCHANGE, ethers.constants.MaxUint256);
    Logger.info(`   交易: ${tx2.hash}`);
    await tx2.wait();
    Logger.success('   ✅ USDC 授权成功!');
  }
  
  // 授权 Conditional Tokens
  const ctContract = new ethers.Contract(CONTRACTS.CONDITIONAL_TOKENS, CT_ABI, walletWithProvider);
  const isCtApproved = await ctContract.isApprovedForAll(address, CONTRACTS.CTF_EXCHANGE);
  if (!isCtApproved) {
    Logger.info('📝 授权 Conditional Tokens...');
    const tx3 = await ctContract.setApprovalForAll(CONTRACTS.CTF_EXCHANGE, true);
    Logger.info(`   交易: ${tx3.hash}`);
    await tx3.wait();
    Logger.success('   ✅ Conditional Tokens 授权成功!');
  }
  
  Logger.divider();
  Logger.success('🎉 所有授权已完成!');
  Logger.info('现在可以运行 npm run dev 启动机器人');
  
  rl.close();
};

run().catch(error => {
  Logger.error(`错误: ${error.message}`);
  process.exit(1);
});

