// Pump Sprint: a selective launch sniper for agent-fun/replay/v2.
//
// Idea, learned from grading the kit pilots on the dev window: buying every
// fresh pump.fun launch loses money, because a launch's real SOL reserve is
// tiny at birth, so the 1%-of-reserve size cap makes each buy small while the
// per-order tx fee stays fixed. The edge is in launches that already proved
// demand: wait until a coin is 5-8 slots old and holds at least 8 SOL of real
// reserve, has 3-7 distinct non-creator buyers (more than that smells like a
// creator cluster waiting to dump), and the creator has not sold. Then buy
// once, up to 0.1 SOL (the size cap binds first at ~0.08 SOL), take profit at
// +15%, cut at -5%, trail after +5%, and never hold past 10 slots. Exits also
// fire the moment the creator sells, or when the last 10 slots of tape sold
// 0.5 SOL net — the tape turning seller-heavy is the dump starting.
//
// The bot is a pure function of the hello and batch messages it is fed: no
// clock, no randomness, no environment, no I/O. The two grader executions
// therefore produce byte-identical action logs.

import { runBot, BPS, type BotState, type Batch, type OrderInput, type Pubkey } from "./vendor/makefun-bot.ts";

// ---- tunables (swept on the kit's local grader, full dev window) ----
const MIN_AGE = 5; // slots since CreateEvent before a first buy is allowed
const MAX_AGE = 8; // slots since CreateEvent after which a coin is done
const MIN_REAL_SOL = 8_000_000_000n; // 8 SOL of real reserve at decision time
const MIN_BUYERS = 3; // distinct non-creator buyers seen before entry
const MAX_BUYERS = 7; // more buyers than this looks like a bundled launch
const MAX_DEV_BUY = 2_500_000_000n; // creator's own buy in the create slot, at most
const STAKE = 100_000_000n; // 0.1 SOL aimed per coin (size cap binds first)
const MIN_BUY = 5_000_000n; // smallest buy worth paying a tx fee for
const BUY_SLIPPAGE_BPS = 1000; // a buy whose fill is >10% worse is refused
const SELL_SLIPPAGE_BPS = 10000;
const TP_BPS = 1500; // sell everything at +15% over cost
const SL_BPS = 500; // sell everything at -5% under cost
const TRAIL_ARM_BPS = 500; // once up 5%, trail the best value
const TRAIL_BPS = 300; // exit on a 3% fall from the best value
const MAX_HOLD = 10; // slots held, at most
const FLOW_WINDOW = 10; // slots of recent tape the flow exit looks at
const EXIT_FLOW_LAMPORTS = 500_000_000n; // exit when the last 10 slots sold 0.5 SOL net
const FEE_BPS = 125n; // protocol 95 + creator 30 bps charged on curve trades

interface Tick {
  slot: number;
  isBuy: boolean;
  sol: bigint;
  user: Pubkey;
}

interface Coin {
  mint: Pubkey;
  createSlot: number;
  creator: Pubkey;
  vq0: bigint;
  vt0: bigint;
  devBuy: bigint;
  trades: number;
  buyers: Set<Pubkey>;
  bought: bigint;
  soldByOthers: bigint;
  bigSellBps: bigint;
  devSold: boolean;
  lastTradeSlot: number;
  recent: Tick[];
  done: boolean;
  complete: boolean;
}

interface Held {
  openedSlot: number;
  txPaid: bigint;
  best: bigint;
  devSoldAtOpen: boolean;
}

/** What selling `tokens` against (vq, vt) pays after curve fees. */
function sellValue(tokens: bigint, vq: bigint, vt: bigint): bigint {
  if (tokens <= 0n || vt <= 0n) return 0n;
  const q = (tokens * vq) / (vt + tokens);
  return q - (q * FEE_BPS + BPS - 1n) / BPS;
}

const coins = new Map<Pubkey, Coin>();
const held = new Map<Pubkey, Held>();
const selling = new Set<Pubkey>();

/** Net lamports bought minus sold over the last FLOW_WINDOW slots. */
function flowNet(c: Coin, slot: number): bigint {
  const from = slot - FLOW_WINDOW;
  let drop = 0;
  while (drop < c.recent.length && c.recent[drop]!.slot <= from) drop++;
  if (drop > 0) c.recent.splice(0, drop);
  let net = 0n;
  for (const t of c.recent) net += t.isBuy ? t.sol : -t.sol;
  return net;
}

function hasPending(state: BotState, mint: Pubkey, side: "buy" | "sell"): boolean {
  for (const p of state.pending.values()) {
    if (p.order.mint === mint && p.order.side === side) return true;
  }
  return false;
}

function readEvents(batch: Batch): void {
  for (const e of batch.events) {
    if (e.event === "CreateEvent") {
      coins.set(e.mint, {
        mint: e.mint,
        createSlot: e.slot,
        creator: e.creator,
        vq0: BigInt(e.virtual_quote_reserves),
        vt0: BigInt(e.virtual_token_reserves),
        devBuy: 0n,
        trades: 0,
        buyers: new Set(),
        bought: 0n,
        soldByOthers: 0n,
        bigSellBps: 0n,
        devSold: false,
        lastTradeSlot: e.slot,
        recent: [],
        done: false,
        complete: false,
      });
    } else if (e.event === "TradeEvent") {
      const c = coins.get(e.mint);
      if (c === undefined) continue;
      const sol = BigInt(e.sol_amount);
      c.trades += 1;
      c.lastTradeSlot = e.slot;
      c.recent.push({ slot: e.slot, isBuy: e.is_buy, sol, user: e.user });
      const isDev = e.user === c.creator;
      if (e.is_buy) {
        c.bought += sol;
        if (isDev && e.slot === c.createSlot) c.devBuy += sol;
        else if (!isDev) c.buyers.add(e.user);
      } else if (isDev) {
        c.devSold = true;
      } else {
        c.soldByOthers += sol;
        const rqBefore = BigInt(e.real_quote_reserves) + sol;
        if (rqBefore > 0n) {
          const bps = (sol * BPS) / rqBefore;
          if (bps > c.bigSellBps) c.bigSellBps = bps;
        }
      }
    } else {
      const c = coins.get(e.mint);
      if (c !== undefined) {
        c.complete = true;
        c.done = true;
      }
    }
  }
}

function onBatch(state: BotState, batch: Batch): OrderInput[] {
  readEvents(batch);
  const orders: OrderInput[] = [];
  const cap = state.hello.caps.max_orders_per_batch;
  const tx = state.txFeeLamports();
  const marks = new Map<Pubkey, { vq: bigint; vt: bigint }>();
  for (const m of batch.marks) {
    marks.set(m.mint, { vq: BigInt(m.virtual_quote_reserves), vt: BigInt(m.virtual_token_reserves) });
  }

  // Fold fills in: track what each held position has paid in tx fees, and
  // drop positions the harness closed for us (client_id starting with "_").
  for (const f of batch.fills) {
    if (f.client_id.startsWith("_")) {
      held.delete(f.mint);
      selling.delete(f.mint);
      continue;
    }
    const h = held.get(f.mint);
    if (f.status !== "rejected" && h !== undefined) h.txPaid += BigInt(f.tx_fee_lamports);
    if (f.side === "buy" && f.status === "filled" && h === undefined) {
      held.set(f.mint, {
        openedSlot: f.slot,
        txPaid: BigInt(f.tx_fee_lamports),
        best: 0n,
        devSoldAtOpen: coins.get(f.mint)?.devSold ?? false,
      });
    }
  }
  for (const mint of [...selling]) if (!hasPending(state, mint, "sell")) selling.delete(mint);
  for (const mint of [...held.keys()]) {
    if (!state.positions.has(mint) && !selling.has(mint) && !hasPending(state, mint, "buy")) held.delete(mint);
  }

  // Exits first: take profit, stop loss, trailing stop, max hold, creator sell.
  for (const [mint, pos] of state.positions) {
    if (orders.length >= cap) break;
    if (selling.has(mint)) continue;
    const c = coins.get(mint);
    let h = held.get(mint);
    if (h === undefined) {
      h = { openedSlot: state.slot, txPaid: tx, best: 0n, devSoldAtOpen: c?.devSold ?? false };
      held.set(mint, h);
    }
    let mk = marks.get(mint);
    if (mk === undefined) {
      const cv = state.curves.get(mint);
      if (cv === undefined) continue;
      mk = { vq: cv.virtual_quote_reserves, vt: cv.virtual_token_reserves };
    }
    const value = sellValue(pos.token_amount, mk.vq, mk.vt) - tx;
    const basis = pos.cost_lamports + h.txPaid;
    if (value > h.best) h.best = value;
    let exit = false;
    if (basis > 0n) {
      if (value * BPS >= basis * (BPS + BigInt(TP_BPS))) exit = true;
      if (value * BPS <= basis * (BPS - BigInt(SL_BPS))) exit = true;
      if (h.best * BPS >= basis * (BPS + BigInt(TRAIL_ARM_BPS)) && value * BPS <= h.best * (BPS - BigInt(TRAIL_BPS))) exit = true;
    }
    if (state.slot - h.openedSlot >= MAX_HOLD) exit = true;
    if (c !== undefined && c.devSold && !h.devSoldAtOpen) exit = true;
    // Flow exit: the tape turned seller-heavy, get out before the dump.
    if (c !== undefined && flowNet(c, state.slot) < -EXIT_FLOW_LAMPORTS) exit = true;
    if (!exit) continue;
    orders.push({ side: "sell", mint, token_amount: pos.token_amount, max_slippage_bps: SELL_SLIPPAGE_BPS });
    selling.add(mint);
    if (c !== undefined) c.done = true;
  }

  // Entries: one buy per qualifying launch, in first-seen order.
  let free = state.freeCashLamports() - tx * BigInt(orders.length);
  let open = state.committedPositionCount();
  for (const c of coins.values()) {
    if (orders.length >= cap) break;
    if (c.done || c.complete) continue;
    const age = state.slot - c.createSlot;
    if (age > MAX_AGE) {
      c.done = true;
      continue;
    }
    if (age < MIN_AGE) continue;
    if (open >= state.hello.caps.max_open_positions) continue;
    const curve = state.curves.get(c.mint);
    if (curve === undefined || curve.complete) continue;
    // Rug filter: big real reserve, a few genuine buyers, creator not sold,
    // creator's own buy modest, no outsized single sell, sells <= buys.
    if (curve.real_quote_reserves < MIN_REAL_SOL) continue;
    if (c.devSold) {
      c.done = true;
      continue;
    }
    if (c.devBuy > MAX_DEV_BUY) continue;
    if (c.buyers.size < MIN_BUYERS || c.buyers.size > MAX_BUYERS) continue;
    if (c.bought > 0n && c.soldByOthers > c.bought) continue;
    if (c.bigSellBps > BPS) continue;
    const maxBuy = state.maxBuyLamports(c.mint);
    const amount = STAKE < maxBuy ? STAKE : maxBuy;
    if (amount < MIN_BUY) continue;
    if (free < amount + tx) continue;
    orders.push({ side: "buy", mint: c.mint, quote_lamports: amount, max_slippage_bps: BUY_SLIPPAGE_BPS });
    free -= amount + tx;
    c.done = true; // one shot per coin: never buy the same launch twice
    open += 1;
  }
  return orders;
}

await runBot({ onBatch });
