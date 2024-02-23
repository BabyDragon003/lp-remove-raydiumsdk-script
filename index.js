const dotenv = require("dotenv");
const bs58 = require("bs58");
const BN = require("bn.js");
const BigNumber = require("bignumber.js");

var colors = require("colors");

const { clusterApiUrl, Connection, PublicKey, Transaction, VersionedTransaction } = require("@solana/web3.js");
// const { createCreateMetadataAccountV3Instruction, PROGRAM_ID } = require("@metaplex-foundation/mpl-token-metadata");
const { Market, MARKET_STATE_LAYOUT_V3 } = require("@project-serum/serum");
const { getKeypairFromEnvironment } = require("@solana-developers/node-helpers");
const {
    getMint,
    getOrCreateAssociatedTokenAccount,
} = require("@solana/spl-token");

const {
    Token,
    TokenAmount,
    Liquidity,
    LOOKUP_TABLE_CACHE,
    MAINNET_PROGRAM_ID,
    DEVNET_PROGRAM_ID,
    TOKEN_PROGRAM_ID,
    SPL_ACCOUNT_LAYOUT,
    TxVersion,
    buildSimpleTransaction,
} = require("@raydium-io/raydium-sdk");


dotenv.config();

const DEVNET_MODE = process.env.DEVNET_MODE === "true";
const PROGRAMIDS = DEVNET_MODE ? DEVNET_PROGRAM_ID : MAINNET_PROGRAM_ID;
const addLookupTableInfo = DEVNET_MODE ? undefined : LOOKUP_TABLE_CACHE;
const makeTxVersion = TxVersion.V0; // LEGACY
const connection = new Connection(DEVNET_MODE ? clusterApiUrl("devnet") : process.env.MAINNET_RPC_URL, "confirmed");
const tokenAddress = process.env.PROGRAM_ADDRESS;

const payer = getKeypairFromEnvironment("PAYER_SECRET_KEY");
console.log("Payer:", payer.publicKey.toBase58());
console.log("Mode:", DEVNET_MODE ? "devnet" : "mainnet");

// const xWeiAmount = (amount, decimals) => {
//     return new BN(new BigNumber(amount.toString() + "e" + decimals.toString()).toFixed(0));
// };

// const xReadableAmount = (amount, decimals) => {
//     return new BN(new BigNumber(amount.toString() + "e-" + decimals.toString()).toFixed(0));
// };

const getWalletTokenAccount = async (connection, wallet) => {
    const walletTokenAccount = await connection.getTokenAccountsByOwner(wallet, {
        programId: TOKEN_PROGRAM_ID,
    });
    return walletTokenAccount.value.map((i) => ({
        pubkey: i.pubkey,
        programId: i.account.owner,
        accountInfo: SPL_ACCOUNT_LAYOUT.decode(i.account.data),
    }));
};

const sendAndConfirmTransactions = async (connection, payer, transactions) => {
    for (const tx of transactions) {
        let signature;
        if (tx instanceof VersionedTransaction) {
            tx.sign([payer]);
            signature = await connection.sendTransaction(tx);
        }
        else
            signature = await connection.sendTransaction(tx, [payer]);
        await connection.confirmTransaction({ signature });
    }
};

const removeLiquidity = async (mintAddress) => {
    console.log("Removing Liquidity...".green, mintAddress);

    const mint = new PublicKey(mintAddress);
    const mintInfo = await getMint(connection, mint);

    const baseToken = new Token(TOKEN_PROGRAM_ID, mintAddress, mintInfo.decimals);
    const quoteToken = new Token(TOKEN_PROGRAM_ID, "So11111111111111111111111111111111111111112", 9, "WSOL", "WSOL");

    const marketAccounts = await Market.findAccountsByMints(connection, baseToken.mint, quoteToken.mint, PROGRAMIDS.OPENBOOK_MARKET);
    if (marketAccounts.length === 0) {
        console.log("Not found market info".red);
        return;
    }

    const marketInfo = MARKET_STATE_LAYOUT_V3.decode(marketAccounts[0].accountInfo.data);
    let poolKeys = Liquidity.getAssociatedPoolKeys({
        version: 4,
        marketVersion: 4,
        baseMint: baseToken.mint,
        quoteMint: quoteToken.mint,
        baseDecimals: baseToken.decimals,
        quoteDecimals: quoteToken.decimals,
        marketId: marketAccounts[0].publicKey,
        programId: PROGRAMIDS.AmmV4,
        marketProgramId: PROGRAMIDS.OPENBOOK_MARKET,
    });
    poolKeys.marketBaseVault = marketInfo.baseVault;
    poolKeys.marketQuoteVault = marketInfo.quoteVault;
    poolKeys.marketBids = marketInfo.bids;
    poolKeys.marketAsks = marketInfo.asks;
    poolKeys.marketEventQueue = marketInfo.eventQueue;

    const walletTokenAccounts = await getWalletTokenAccount(connection, payer.publicKey);

    const lpToken = new Token(TOKEN_PROGRAM_ID, poolKeys.lpMint, poolKeys.lpDecimals);
    const tokenAccount = await getOrCreateAssociatedTokenAccount(connection, payer, poolKeys.lpMint, payer.publicKey);
    
    console.log("LP Amount:".green, tokenAccount.amount);

    const amountIn = new TokenAmount(lpToken, tokenAccount.amount);

    const { innerTransactions } = await Liquidity.makeRemoveLiquidityInstructionSimple({
        connection,
        poolKeys,
        userKeys: {
            owner: payer.publicKey,
            payer: payer.publicKey,
            tokenAccounts: walletTokenAccounts,
        },
        amountIn: amountIn,
        makeTxVersion,
    });

    const transactions = await buildSimpleTransaction({
        connection,
        makeTxVersion,
        payer: payer.publicKey,
        innerTransactions,
        addLookupTableInfo,
    });

    await sendAndConfirmTransactions(connection, payer, transactions);
    console.log("LP Remove Success!".green);
}

removeLiquidity(tokenAddress);