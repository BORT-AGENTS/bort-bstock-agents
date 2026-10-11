// Addresses and scope for Desk Notes on BSC mainnet (chain 56). Verified 2026-09-27.
'use strict';

const CHAIN_ID = 56;

const ADDR = Object.freeze({
  BAP578: '0x15b15df2ffff6653c21c11b93fb8a7718ce854ce',
  VAULT_MANAGER: '0x0eC7a7D90A92eB1c86D9A082Ff5b75518ACF4102',
  CIRCUIT_BREAKER: '0x907c460b8a9d698e2db460d86ddafa5bb5f12b0a',
  ROUTER: '0x1b81D678ffb9C0263b24A97847620C99d213eB14', // PancakeSwap V3 SwapRouter
  QUOTER: '0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997', // PancakeSwap V3 QuoterV2
  V3_FACTORY: '0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865',
  WBNB: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c',
  USDT: '0x55d398326f99059fF775485246999027B3197955',
  BNB_USD_POOL: '0x172fcD41E0913e95784454622d1c3724f546f849', // WBNB/USDT fee 100
  U: '0xcE24439F2D9C6a2289F741120FE202248B666666', // United Stables ($U), EIP-3009, 18 decimals
  SAFE: '0x78b90b71eF598A13530cF77a3E69CFd8Fb0b24fB', // BORT's 2-of-3 Safe, owner of the logic contract
  // ERC-6551: every agent wallet is registry.createAccount(ACCOUNT_PROXY, salt 0, 56, BAP578, tokenId),
  // then initialize(ACCOUNT_V3_IMPL). Both calls are permissionless, so the relayer can make them.
  ERC6551_REGISTRY: '0x000000006551c19487814612e58FE06813775758',
  ACCOUNT_PROXY: '0x55266d75D1a14E4572138116aF39863Ed6596E7F',
  ACCOUNT_V3_IMPL: '0x41C8f39463A868d3A88af00cd0fe7102F30E44eC',
});

// Each bStock with its Ondo twin (same underlying) and the USDT pool fee tier that is deepest for it.
// The first five were checked on the factory on 2026-09-27; the rest came from probes/bstock-universe.js
// on 2026-09-30: of Binance's 80 bStocks on BSC, the ones whose pool a 1,000 USD buy moves by 0.1% or
// less and that have an Ondo twin (the reference price), less SPCXB (SpaceX is private, so its "real
// share" is synthetic) and SKHYB (SK Hynix trades in Korea, so its reference is stale in US hours).
// MUB stays sell-only (`buyable: false`): 1,000 USD moves its pool about 1.1%.
const STOCKS = Object.freeze([
  { symbol: 'NVDAB', underlying: 'NVDA', address: '0x02fca66c1d1afb4e2a7884261eb00f63598a7436', usdtFee: 2500, ondo: { symbol: 'NVDAon', address: '0xa9ee28c80f960b889dfbd1902055218cba016f75' } },
  { symbol: 'QQQB', underlying: 'QQQ', address: '0x205812cdbed920aff76c6580abd681a46d11efc7', usdtFee: 100, ondo: { symbol: 'QQQon', address: '0x0cde6936d305d5b34667fc46425e852efd73559a' } },
  { symbol: 'TSLAB', underlying: 'TSLA', address: '0x5b1910eaad6450e50f816082aa078c41f10c292f', usdtFee: 2500, ondo: { symbol: 'TSLAon', address: '0x2494b603319d4d9f9715c9f4496d9e0364b59d93' } },
  { symbol: 'SPYB', underlying: 'SPY', address: '0x7138b48df7d98d7e3cc221bfe7192d0a178182d8', usdtFee: 100, ondo: { symbol: 'SPYon', address: '0x6a708ead771238919d85930b5a0f10454e1c331a' } },
  { symbol: 'MUB', underlying: 'MU', address: '0xcdf2f3e0fa43c47a6662a91c9e4a7c5f69762699', usdtFee: 2500, buyable: false, ondo: { symbol: 'MUon', address: '0x8b6acf6041a81567f012ff6a4c6d96d5818d74bf' } },
  { symbol: 'GOOGLB', underlying: 'GOOGL', address: '0x3f53de71c126bdabae20f9cd64848d317f6c3238', usdtFee: 2500, ondo: { symbol: 'GOOGLon', address: '0x091fc7778e6932d4009b087b191d1ee3bac5729a' } },
  { symbol: 'BABAB', underlying: 'BABA', address: '0x4ef9d3062c7f6eba4aae4990c5036598c6eff4ec', usdtFee: 2500, ondo: { symbol: 'BABAon', address: '0xd5964f3fcee8d649995ab88f04b8982539c282d2' } },
  { symbol: 'AAPLB', underlying: 'AAPL', address: '0x431a3bee82e2ca41e49895cbece5bb0f76a89b7a', usdtFee: 2500, ondo: { symbol: 'AAPLon', address: '0x390a684ef9cade28a7ad0dfa61ab1eb3842618c4' } },
  { symbol: 'CRCLB', underlying: 'CRCL', address: '0x80f3d493ebce97e343c53d29a137942416b4ffc0', usdtFee: 2500, ondo: { symbol: 'CRCLon', address: '0x992879cd8ce0c312d98648875b5a8d6d042cbf34' } },
  { symbol: 'MSFTB', underlying: 'MSFT', address: '0x80106cb3ead06659a5ad19df39d9b4733863b9b0', usdtFee: 2500, ondo: { symbol: 'MSFTon', address: '0x6bfe75d1ad432050ea973c3a3dcd88f02e2444c3' } },
  { symbol: 'AMZNB', underlying: 'AMZN', address: '0x1a4b499833a79a09ad7cf1d42d7dacf71e92eb00', usdtFee: 2500, ondo: { symbol: 'AMZNon', address: '0x4553cfe1c09f37f38b12dc509f676964e392f8fc' } },
  { symbol: 'SNDKB', underlying: 'SNDK', address: '0x3ee4df61bd4f867e349beae8bfe07bc31b4850fb', usdtFee: 2500, ondo: { symbol: 'SNDKon', address: '0x4fd67cb8cfedc718bac984b5936abe3330d0a2a4' } },
  { symbol: 'HOODB', underlying: 'HOOD', address: '0xa394dcea3fd3847fd793afbfd163e2e3858b7c65', usdtFee: 2500, ondo: { symbol: 'HOODon', address: '0x19601179a60f55ff6636f5d1a8b6671053bd60a8' } },
  { symbol: 'MSTRB', underlying: 'MSTR', address: '0xe87afb3076aeb0f9b14e368de8145ae6a2826a14', usdtFee: 2500, ondo: { symbol: 'MSTRon', address: '0x7313ea16493b2f55054df0131a3a14b043ec8992' } },
  { symbol: 'METAB', underlying: 'META', address: '0x7425889fe94f9d693e8daefe88bcced6acfef4c0', usdtFee: 2500, ondo: { symbol: 'METAon', address: '0xd7df5863a3e742f0c767768cdfcb63f09e0422f6' } },
  { symbol: 'NFLXB', underlying: 'NFLX', address: '0xd6829ea836b6fa224d099d40e54b31262f874631', usdtFee: 2500, ondo: { symbol: 'NFLXon', address: '0x7048f5227b032326cc8dbc53cf3fddd947a2c757' } },
  { symbol: 'GMEB', underlying: 'GME', address: '0x46ceefda28dd7207059ed19b0acdc026955bb15c', usdtFee: 2500, ondo: { symbol: 'GMEon', address: '0xdabb9aff4cf02f26d2014e4ca9f94ac6fe6572a3' } },
  { symbol: 'TSMB', underlying: 'TSM', address: '0xab78b89b5bb00236be0b4b20704cbfa04efc711c', usdtFee: 2500, ondo: { symbol: 'TSMon', address: '0xc37042a7a4fa510d8884a433762ab87257b91965' } },
]);

// The fixed footer on every note. Wording rule: record of holdings and observations, never advice.
const NOTE_FOOTER =
  'This is a record of what this agent holds and observed. It is not investment advice, and not advice to buy or sell anything.';

const DEFAULT_RPC = 'https://bsc-dataseed.bnbchain.org';
const RPC_URL = process.env.BSC_RPC || DEFAULT_RPC;

module.exports = { CHAIN_ID, ADDR, STOCKS, NOTE_FOOTER, RPC_URL, DEFAULT_RPC };
