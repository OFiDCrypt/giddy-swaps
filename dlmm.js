import dotenv from 'dotenv';
import fs from 'node:fs/promises';
import path from 'path';
import BN from 'bn.js';
import { PublicKey, ComputeBudgetProgram, VersionedTransaction, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { getAssociatedTokenAddressSync, getAccount, getOrCreateAssociatedTokenAccount, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';

dotenv.config();

let DLMM;

async function loadDLMM() {
  const { createRequire } = await import('module');
  const require = createRequire(import.meta.url);
  const pkg = require('@meteora-ag/dlmm');
  DLMM = pkg.DLMM || pkg.default?.DLMM || pkg.default;
  if (!DLMM || typeof DLMM.create !== 'function') {
    console.error("❌ Failed to load DLMM module.");
    process.exit(1);
  }
}

function validatePublicKeys(...keys) {
  return keys.every(k => k && typeof k.toBase58 === 'function');
}

export async function dlmmSwap(wallet, connection, inputMint, outputMint, amountIn = process.env.SWAP_AMOUNT) {
  await loadDLMM();

  const POOL_ADDRESS = new PublicKey('8pJonw6WVjQkDndb6HGuCMdxb4sXiDfeFumxconoKB5');
  const USDC_MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
  const GIDDY_MINT = new PublicKey('8kQzvMELBQGSiFmrXqLuDSpYVLKkNoXE4bUQCC14wj3Z');
  const PROGRAM_ID = new PublicKey('LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo');
  const amount = new BN(amountIn);
  const slippageBps = new BN(process.env.SLIPPAGE_BPS || 50);
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const logPath = path.join('swaps', `dlmm_${timestamp}.json`);

  if (!validatePublicKeys(wallet.publicKey, POOL_ADDRESS, inputMint, outputMint)) {
    console.error("❌ Invalid PublicKey detected.");
    return null;
  }

  try {
    // Check SOL balance
    const solBalance = await connection.getBalance(wallet.publicKey);
    if (solBalance < 0.02 * LAMPORTS_PER_SOL) {
      throw new Error(`Insufficient SOL balance: ${solBalance / LAMPORTS_PER_SOL} SOL (min 0.02 SOL)`);
    }

    // Ensure ATAs
    const userTokenIn = getAssociatedTokenAddressSync(
      inputMint,
      wallet.publicKey,
      false,
      inputMint.equals(GIDDY_MINT) ? TOKEN_2022_PROGRAM_ID : new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')
    );
    const userTokenOut = getAssociatedTokenAddressSync(
      outputMint,
      wallet.publicKey,
      false,
      outputMint.equals(GIDDY_MINT) ? TOKEN_2022_PROGRAM_ID : new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')
    );
    await getOrCreateAssociatedTokenAccount(
      connection,
      wallet,
      inputMint,
      wallet.publicKey,
      false,
      'confirmed',
      { computeBudget: [ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 2_000_000 })] },
      inputMint.equals(GIDDY_MINT) ? TOKEN_2022_PROGRAM_ID : new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')
    ).catch(err => {
      throw new Error(`Failed to create input ATA: ${err.message}`);
    });
    await getOrCreateAssociatedTokenAccount(
      connection,
      wallet,
      outputMint,
      wallet.publicKey,
      false,
      'confirmed',
      { computeBudget: [ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 2_000_000 })] },
      outputMint.equals(GIDDY_MINT) ? TOKEN_2022_PROGRAM_ID : new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')
    ).catch(err => {
      throw new Error(`Failed to create output ATA: ${err.message}`);
    });

    // Check input balance
    const inputBalance = await getAccount(connection, userTokenIn, 'confirmed', inputMint.equals(GIDDY_MINT) ? TOKEN_2022_PROGRAM_ID : new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')).catch(() => ({ amount: 0 }));
    if (inputBalance.amount < amount) {
      throw new Error(`Insufficient ${inputMint.equals(USDC_MINT) ? 'USDC' : 'GIDDY'} balance: ${inputBalance.amount} < ${amount}`);
    }

    const dlmmPool = await DLMM.create(connection, POOL_ADDRESS, { cluster: 'mainnet-beta' });

    // Full state refresh
    await dlmmPool.update({ lbPair: true, binArrays: true, binArrayBitmap: true });
    const bitmapExt = dlmmPool.binArrayBitmapExtension;
    console.log('Bitmap Extension:', bitmapExt ? bitmapExt.toBase58() : 'None');

    // Verify bitmap PDA
    const [expectedBitmapPda] = await PublicKey.findProgramAddress(
      [Buffer.from('bitmap_extension'), POOL_ADDRESS.toBuffer()],
      PROGRAM_ID
    );
    console.log('Expected Bitmap PDA:', expectedBitmapPda.toBase58());
    const envBitmapPda = new PublicKey('CBxa8uqt4n1BVAupQGY6AxRKEYq7RQKVeJnvDHAZCykT');
    if (bitmapExt && !bitmapExt.equals(envBitmapPda)) {
      throw new Error(`Bitmap extension mismatch: expected ${expectedBitmapPda.toBase58()}, got ${bitmapExt.toBase58()}`);
    }
    if (!bitmapExt && expectedBitmapPda.equals(envBitmapPda)) {
      console.warn('⚠️ No bitmap extension in pool, but .env specifies one. Proceeding without it.');
    }

    // Log pool details
    console.log("🧪 DLMM Pool Inspection:");
    console.log("tokenX:", dlmmPool.tokenX?.toBase58?.() || 'undefined');
    console.log("tokenY:", dlmmPool.tokenY?.toBase58?.() || 'undefined');
    console.log("activeBin:", dlmmPool.lbPair?.activeId?.toString?.() || 'undefined');
    console.log("binArrays:", (await dlmmPool.getBinArrays()).length);
    console.log("lbPair:", {
      tokenXMint: dlmmPool.lbPair?.tokenXMint?.toBase58?.() || 'undefined',
      tokenYMint: dlmmPool.lbPair?.tokenYMint?.toBase58?.() || 'undefined',
    });

    // Verify token order
    const fromTokenIsX = inputMint.toBase58() === dlmmPool.tokenX.publicKey.toBase58();
    console.log("Swap Direction:", fromTokenIsX ? "tokenX → tokenY" : "tokenY → tokenX");

    // Get bin arrays
    const binArrays = await dlmmPool.getBinArraysForSwap(fromTokenIsX);
    console.log("binArrays length:", binArrays.length);

    // Get quote
    const quote = await dlmmPool.swapQuoteExactIn(amount, fromTokenIsX, slippageBps, binArrays);
    console.log("quote:", {
      amountOut: quote.amountOut?.toString?.() || 'undefined',
      minAmountOut: quote.minAmountOut?.toString?.() || 'undefined',
      binArraysPubkey: quote.binArraysPubkey?.map(pk => pk.toBase58()) || 'undefined',
    });

    // Build transaction
    const swapTx = await dlmmPool.swapExactIn({
      amountIn: amount,
      minAmountOut: quote.minAmountOut,
      fromTokenIsX,
      user: wallet.publicKey,
      binArraysPubkey: quote.binArraysPubkey,
      referral: new PublicKey('11111111111111111111111111111111'),
      userTokenIn,
      userTokenOut,
    });

    // Add compute budget
    swapTx.add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1_000_000 })
    );

    // Simulate
    const sim = await connection.simulateTransaction(swapTx);
    if (sim.value.err) {
      console.error('❌ Simulation failed:', sim.value.logs.join('\n'));
      throw new Error(`Simulation failed: ${sim.value.logs.join('\n')}`);
    }

    // Send
    const sig = await connection.sendTransaction(swapTx, { signers: [wallet], skipPreflight: false });
    await connection.confirmTransaction(sig, 'confirmed');

    await fs.writeFile(logPath, JSON.stringify({
      timestamp,
      pool: POOL_ADDRESS.toBase58(),
      user: wallet.publicKey.toBase58(),
      from: userTokenIn.toBase58(),
      to: userTokenOut.toBase58(),
      amountIn: amount.toString(),
      amountOut: quote.amountOut.toString(),
      txid: sig,
      status: 'submitted',
    }, null, 2));

    console.log("✅ DLMM swap submitted:", sig);
    return { txid: sig, amountOut: quote.amountOut.toString(), minOutAmount: quote.minAmountOut.toString() };
  } catch (err) {
    await fs.writeFile(logPath, JSON.stringify({
      timestamp,
      pool: POOL_ADDRESS.toBase58(),
      user: wallet.publicKey.toBase58(),
      from: inputMint.toBase58(),
      to: outputMint.toBase58(),
      amountIn: amount.toString(),
      error: err.message || err.toString(),
      logs: err.logs || [],
      status: 'failed',
    }, null, 2));

    console.error("❌ DLMM swap failed:", err.message || err, err.logs || '');
    return null;
  }
}