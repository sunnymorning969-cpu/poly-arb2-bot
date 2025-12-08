import { ethers } from 'ethers';
import { ClobClient } from '@polymarket/clob-client';
import CONFIG from './config';
import Logger from './logger';

// Polygon 合约地址
const CONTRACTS = {
  // Polymarket CTF Exchange
  CTF_EXCHANGE: '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E',
  // Conditional Tokens
  CONDITIONAL_TOKENS: '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045',
  // USDC.e (bridged)
  USDC_E: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174',
  // USDC (native)
  USDC: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
};

// ERC20 ABI
const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function decimals() view returns (uint8)',
];

// Conditional Tokens ABI
const CT_ABI = [
  'function isApprovedForAll(address owner, address operator) view returns (bool)',
  'function setApprovalForAll(address operator, bool approved)',
];

let clientInstance: ClobClient | null = null;
let providerInstance: ethers.providers.JsonRpcProvider | null = null;
let walletInstance: ethers.Wallet | null = null;

// 获取 Provider
const getProvider = (): ethers.providers.JsonRpcProvider => {
  if (!providerInstance) {
    providerInstance = new ethers.providers.JsonRpcProvider('https://polygon-rpc.com');
  }
  return providerInstance;
};

// 获取 Wallet
const getWallet = (): ethers.Wallet => {
  if (!walletInstance) {
    if (!CONFIG.PRIVATE_KEY) {
      throw new Error('PRIVATE_KEY 未配置');
    }
    walletInstance = new ethers.Wallet(CONFIG.PRIVATE_KEY, getProvider());
  }
  return walletInstance;
};

// 检查并授权 ERC20 代币
const checkAndApproveERC20 = async (
  tokenAddress: string,
  tokenName: string,
  spenderAddress: string,
  spenderName: string
): Promise<boolean> => {
  const wallet = getWallet();
  const address = CONFIG.PROXY_WALLET || wallet.address;
  const token = new ethers.Contract(tokenAddress, ERC20_ABI, wallet);
  
  try {
    // 检查当前授权额度
    const allowance = await token.allowance(address, spenderAddress);
    const minAllowance = ethers.utils.parseUnits('1000000', 6); // 1M USDC
    
    if (allowance.gte(minAllowance)) {
      Logger.info(`✅ ${tokenName} -> ${spenderName}: 已授权`);
      return true;
    }
    
    // 需要授权
    Logger.warning(`⏳ ${tokenName} -> ${spenderName}: 授权中...`);
    
    const maxApproval = ethers.constants.MaxUint256;
    const tx = await token.approve(spenderAddress, maxApproval);
    
    Logger.info(`📝 交易已发送: ${tx.hash}`);
    await tx.wait();
    
    Logger.success(`✅ ${tokenName} -> ${spenderName}: 授权成功!`);
    return true;
    
  } catch (error: any) {
    Logger.error(`❌ ${tokenName} 授权失败: ${error.message}`);
    return false;
  }
};

// 检查并授权 Conditional Tokens (ERC1155)
const checkAndApproveCT = async (): Promise<boolean> => {
  const wallet = getWallet();
  const address = CONFIG.PROXY_WALLET || wallet.address;
  const ct = new ethers.Contract(CONTRACTS.CONDITIONAL_TOKENS, CT_ABI, wallet);
  
  try {
    // 检查是否已授权
    const isApproved = await ct.isApprovedForAll(address, CONTRACTS.CTF_EXCHANGE);
    
    if (isApproved) {
      Logger.info(`✅ Conditional Tokens -> CTF Exchange: 已授权`);
      return true;
    }
    
    // 需要授权
    Logger.warning(`⏳ Conditional Tokens -> CTF Exchange: 授权中...`);
    
    const tx = await ct.setApprovalForAll(CONTRACTS.CTF_EXCHANGE, true);
    
    Logger.info(`📝 交易已发送: ${tx.hash}`);
    await tx.wait();
    
    Logger.success(`✅ Conditional Tokens -> CTF Exchange: 授权成功!`);
    return true;
    
  } catch (error: any) {
    Logger.error(`❌ Conditional Tokens 授权失败: ${error.message}`);
    return false;
  }
};

// 自动授权所有必要的合约
export const autoApprove = async (): Promise<boolean> => {
  Logger.info('🔐 检查钱包授权状态...');
  
  let allSuccess = true;
  
  // 1. 授权 USDC.e 到 CTF Exchange
  const usdceApproved = await checkAndApproveERC20(
    CONTRACTS.USDC_E,
    'USDC.e',
    CONTRACTS.CTF_EXCHANGE,
    'CTF Exchange'
  );
  allSuccess = allSuccess && usdceApproved;
  
  // 2. 授权 USDC 到 CTF Exchange
  const usdcApproved = await checkAndApproveERC20(
    CONTRACTS.USDC,
    'USDC',
    CONTRACTS.CTF_EXCHANGE,
    'CTF Exchange'
  );
  allSuccess = allSuccess && usdcApproved;
  
  // 3. 授权 Conditional Tokens 到 CTF Exchange
  const ctApproved = await checkAndApproveCT();
  allSuccess = allSuccess && ctApproved;
  
  if (allSuccess) {
    Logger.success('🔓 所有授权已完成!');
  } else {
    Logger.warning('⚠️ 部分授权失败，可能影响交易');
  }
  
  return allSuccess;
};

// 初始化客户端
export const initClient = async (): Promise<ClobClient> => {
  if (clientInstance) {
    return clientInstance;
  }

  if (!CONFIG.PRIVATE_KEY) {
    throw new Error('PRIVATE_KEY 未配置');
  }

  const wallet = getWallet();

  const client = new ClobClient(
    CONFIG.CLOB_API,
    CONFIG.CHAIN_ID,
    wallet,
    undefined,
    undefined,
    CONFIG.PROXY_WALLET || undefined
  );

  // 创建或获取 API Key
  await client.createOrDeriveApiKey();
  
  clientInstance = client;
  Logger.success('CLOB 客户端初始化成功');
  
  // 自动授权
  await autoApprove();
  
  return client;
};

export const getClient = (): ClobClient | null => {
  return clientInstance;
};

// 获取余额
let cachedBalance: number | null = null;
let balanceCacheTime = 0;

export const getBalance = async (): Promise<number> => {
  const now = Date.now();
  if (cachedBalance !== null && now - balanceCacheTime < 60000) {
    return cachedBalance;
  }

  try {
    if (!CONFIG.PRIVATE_KEY) return 0;
    
    const provider = getProvider();
    const wallet = getWallet();
    const address = CONFIG.PROXY_WALLET || wallet.address;
    
    // USDC.e on Polygon
    const usdc = new ethers.Contract(CONTRACTS.USDC_E, ERC20_ABI, provider);
    
    const balance = await usdc.balanceOf(address);
    cachedBalance = parseFloat(ethers.utils.formatUnits(balance, 6));
    balanceCacheTime = now;
    
    return cachedBalance;
  } catch (error) {
    Logger.warning(`获取余额失败: ${error}`);
    return cachedBalance || 0;
  }
};

// 获取钱包地址
export const getWalletAddress = (): string => {
  if (!CONFIG.PRIVATE_KEY) return '';
  const wallet = getWallet();
  return CONFIG.PROXY_WALLET || wallet.address;
};

