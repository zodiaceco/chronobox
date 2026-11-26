// -*- mode: Bluespec; -*-
/**
 * Chronobox key mechanism: a formal model for independent review.
 * Read MECHANISM.md first; it states the setups, assumptions and properties
 * in prose. This file is the same thing, precise enough for a model checker.
 *
 * Three setups, wired as the app (zodiaceco/chronobox, src/lib/chronobox.ts) deploys them:
 *
 *   simple       Vault Safe (owner: burn address) + Vault Delay + Roles.
 *                The hot wallet H may queue anything on Vault Delay and cancel.
 *
 *   guardianVeto ("with guardian") adds a guardian key G and a Council Safe
 *                (owners H and G, both must sign). Everything, including a
 *                guardian change, waits in Vault Delay; H and G may each cancel
 *                it, so G can stop its own replacement (the veto). The Council
 *                may swap keys instantly through its Roles role. It cannot move
 *                funds or change other vault settings.
 *
 *   guardianRecovery adds the Recovery Delay: it acts on the Council, is
 *                owned by the Vault, and G is its only module. G may queue a
 *                takeover; it waits RECOVERY, and H or G may cancel it.
 *
 * The stock contracts are taken as specified, not modelled in detail:
 *   - Zodiac Delay: modules queue; anyone executes the oldest item once
 *     now - createdAt >= cooldown (the cooldown at execution time) and before
 *     cooldown + expiration; the owner cancels with setTxNonce, which drops a
 *     prefix of the queue; expired items can be skipped by anyone.
 *   - Zodiac Roles: a member may make exactly the calls its role allows.
 *   - Safe: owners at the threshold act at once; modules act as the Safe.
 *
 * Abstractions:
 *   - time moves in whole days (24 h steps); DELAY is a multiple of a day;
 *   - the vault holds one balance, paid out all at once;
 *   - "anything" a key may queue is reduced to the changes that matter for
 *     control (see Effect);
 *   - two parties. The defender is the owner and the guardian, cooperating
 *     and following the response plan in `defense`. The attacker holds the
 *     keys its scenario gives it and may do anything those keys allow, in
 *     any order, including first;
 *   - a leaked key is a copy: both parties hold it. A taken key is held by
 *     the attacker only (coercion that outlasts the delay, or a stolen
 *     device without a backup). A hostile guardian means
 *     only the attacker holds G. A lost key is held by nobody;
 *   - fresh keys: H2 and G2 belong to the defender, HA and GA to the attacker.
 */
module chronobox {

  // ---------------------------------------------------------------------
  // Parameters
  // ---------------------------------------------------------------------

  pure val DAY = 24
  /** The one setting: every queue waits this long (hours, a multiple of DAY). */
  pure val DELAY = 48
  pure val COOLDOWN_A = DELAY  // vault Delay
  pure val EXPIRATION = 168    // a ready item can be executed for 7 days, then it expires (Delay default, not a setting)
  pure val RESPONSE = DELAY - DAY  // the defender cancels a foreign item before its delay runs out
  /**
   * A coercer holds the hot wallet, then leaves without it. Modelled at the longest such coercion
   * that still leaves the owner a day to cancel: it ends one day before the coercer's first item
   * could run. Coercion that lasts until that item can run counts as "hot key taken".
   */
  pure val COERCION = DELAY - DAY
  pure val MAX_QUEUE = 2       // bound on queue length, to keep the model finite
  /**
   * The recovery wait (guardianRecovery). 6 months in the product; here a
   * multiple of the delay, which is what the properties depend on: it must be
   * longer than the delay, so the owner always has time to cancel.
   */
  pure val RECOVERY = 4 * DELAY
  pure val HORIZON = RECOVERY + 3 * DELAY + DAY  // time stops here, to keep the model finite; every deadline below is earlier

  // ---------------------------------------------------------------------
  // State
  //
  // Each right is its own field, as on chain:
  //   hot        the module of the Vault Delay (queues anything on the Vault)
  //   cancelers  the members of the Roles "cancel" role (Vault Delay, Recovery Delay)
  //   owners     the owners of the Council Safe (all must sign); empty in the simple setup
  //   recMod     the module of the Recovery Delay (queues a recovery); "" without recovery
  //   councilRole  whether the Council still has its Roles role on the Vault
  // ---------------------------------------------------------------------

  type Effect =
    | Payout(str)                    // the vault pays everything to "defender" or "attacker"
    | SetCooldownA(int)              // shortens or lengthens the Vault Delay
    | SetCouncilRole(bool)           // gives or takes the Council's Roles role
    | SetGuardian(str)               // the Vault replaces the guardian everywhere (queued on the Vault Delay)
    | Rekey({ h: str, g: str })      // the Vault replaces both keys everywhere (queued on the Vault Delay)
    | Recover(str)                   // the Council, run by the Recovery Delay, swaps its hot-wallet owner (any transaction the guardian queues)
    | RecoverApp(str)                // the app's recovery: the Council's key swap, which reverts without the Council's role

  type Item = { eff: Effect, at: int, by: str }

  type State = {
    setup: str,
    scenario: str,
    time: int,
    funds: str,                      // "vault", "defender" or "attacker"
    cooldownA: int,
    hot: str,
    cancelers: Set[str],
    owners: Set[str],
    recMod: str,
    councilRole: bool,
    queueA: List[Item],              // Vault Delay
    queueC: List[Item],              // Recovery Delay (guardianRecovery)
    defender: Set[str],
    attacker: Set[str],
  }

  var s: State

  // ---------------------------------------------------------------------
  // Who can do what
  // ---------------------------------------------------------------------

  pure def keysOf(st: State, p: str): Set[str] = if (p == "defender") st.defender else st.attacker
  pure def holds(st: State, p: str, k: str): bool = k != "" and keysOf(st, p).contains(k)
  pure def hasAny(st: State, p: str, ks: Set[str]): bool = keysOf(st, p).intersect(ks) != Set()
  pure def only(st: State, k: str): bool = holds(st, "defender", k) and not(holds(st, "attacker", k))

  pure def guarded(st: State): bool = st.setup != "simple"
  pure def recoveryOn(st: State): bool = st.setup == "guardianRecovery"

  /** The Council acts when all its owners sign. */
  pure def controls(st: State, p: str): bool = st.owners != Set() and st.owners.subseteq(keysOf(st, p))

  pure def canQueueA(st: State, p: str): bool = holds(st, p, st.hot)
  /** The cancel role; the Council can give itself that role for one step, so it can cancel too while it has its role. */
  pure def canCancelA(st: State, p: str): bool = hasAny(st, p, st.cancelers) or (st.councilRole and controls(st, p))
  /** Only the Recovery Delay's module queues a recovery. The cancel role covers the Recovery Delay too. */
  pure def canQueueC(st: State, p: str): bool = recoveryOn(st) and holds(st, p, st.recMod)
  pure def canCancelC(st: State, p: str): bool = recoveryOn(st) and canCancelA(st, p)

  /** The guardian's seat on the Council: the owner that is not the hot wallet. */
  pure def gKey(st: State): str = st.owners.exclude(Set(st.hot)).fold("", (a, b) => b)

  /** The attacker holds a key with any power on the Vault Delay, the cancel role or the Council. */
  pure def attackerOnKeys(st: State): bool = holds(st, "attacker", st.hot) or hasAny(st, "attacker", st.cancelers) or hasAny(st, "attacker", st.owners)
  /** ... or can queue a recovery. */
  pure def attackerPowerful(st: State): bool = attackerOnKeys(st) or (recoveryOn(st) and holds(st, "attacker", st.recMod))

  /** The defender alone holds every key that has power. */
  pure def recovered(st: State): bool =
    not(attackerPowerful(st)) and holds(st, "defender", st.hot)
      and (not(guarded(st)) or controls(st, "defender"))
      and (not(recoveryOn(st)) or holds(st, "defender", st.recMod))

  pure def age(st: State, i: Item): int = st.time - i.at
  pure def ready(st: State, i: Item, cd: int): bool = age(st, i) >= cd and age(st, i) < cd + EXPIRATION
  pure def expired(st: State, i: Item, cd: int): bool = age(st, i) >= cd + EXPIRATION

  /** The Vault, through the Vault Delay, replaces keys everywhere: Delay module, cancel role, Council, Recovery Delay. */
  pure def vaultRekey(st: State, h: str, g: str): State =
    if (guarded(st)) { ...st, hot: h, cancelers: Set(h, g), owners: Set(h, g), recMod: if (recoveryOn(st)) g else "" }
    else { ...st, hot: h, cancelers: Set(h) }

  /**
   * The Council's instant key swap (both owners sign): its own owners always; on the Vault (hot
   * wallet, cancel role) only while it has its Roles role. It cannot touch the Recovery Delay,
   * which the Vault owns: the old guardian stays its module until a Vault Delay item changes it.
   */
  pure def councilRekey(st: State, h: str, g: str): State =
    if (st.councilRole) { ...st, owners: Set(h, g), hot: h, cancelers: Set(h, g) } else { ...st, owners: Set(h, g) }

  /**
   * A recovery runs as the Council: it swaps the hot wallet's seat among the Council's owners,
   * whether or not the Council still has its role, and with the role it replaces the hot wallet on the Vault.
   * If the hot wallet is no longer an owner, the swap reverts and nothing changes.
   */
  pure def recover(st: State, h: str): State =
    if (not(st.owners.contains(st.hot))) st
    else {
      val seated = { ...st, owners: st.owners.exclude(Set(st.hot)).union(Set(h)) }
      if (st.councilRole) { ...seated, hot: h, cancelers: st.cancelers.exclude(Set(st.hot)).union(Set(h)) } else seated
    }

  pure def apply(st: State, e: Effect): State = match e {
    | Payout(p) => if (st.funds == "vault") { ...st, funds: p } else st
    | SetCooldownA(n) => { ...st, cooldownA: n }
    | SetCouncilRole(b) => { ...st, councilRole: b }
    | SetGuardian(g) => vaultRekey(st, st.hot, g)
    | Rekey(r) => vaultRekey(st, r.h, r.g)
    | Recover(h) => recover(st, h)
    | RecoverApp(h) => if (st.councilRole) recover(st, h) else st
  }

  pure def dropFirst(l: List[Item], n: int): List[Item] = l.slice(n, l.length())
  pure def firstOwn(l: List[Item]): int =
    l.indices().filter(i => l[i].by == "defender").fold(l.length(), (a, b) => if (b < a) b else a)
  /**
   * The last foreign item the defender should cancel now. Cancelling drops a
   * prefix of the queue. Where the attacker cannot cancel the defender's own
   * items, the defender never cancels past its oldest own item: items behind
   * it run later anyway and are cancelled once it has run. Where the attacker
   * can cancel the defender's items, deferring is unsafe (the attacker would
   * cancel the defender's item and execute its own matured item at once), so
   * the defender cancels every foreign item, own items included.
   */
  pure def lastForeign(l: List[Item], attackerCanCancel: bool): int = {
    val limit = if (attackerCanCancel) l.length() else firstOwn(l)
    l.indices().filter(i => l[i].by != "defender" and i < limit).fold(-1, (a, b) => if (b > a) b else a)
  }

  pure def pending(l: List[Item], e: Effect): bool = l.indices().exists(i => l[i].by == "defender" and l[i].eff == e)
  pure def enqueue(l: List[Item], e: Effect, t: int, by: str): List[Item] = l.append({ eff: e, at: t, by: by })

  // ---------------------------------------------------------------------
  // The defender's response plan (deterministic; first matching rule wins)
  // ---------------------------------------------------------------------

  pure def goodH(st: State): str = if (only(st, st.hot)) st.hot else "H2"
  pure def goodG(st: State): str = if (only(st, gKey(st))) gKey(st) else "G2"

  /** The guardian side is clean: the defender alone holds the guardian's seat, cancel right and recovery right. */
  pure def guardianClean(st: State): bool =
    only(st, gKey(st)) and st.cancelers == Set(st.hot, gKey(st)) and (not(recoveryOn(st)) or st.recMod == gKey(st))

  /** Returns (rule, next state). "none" means nothing to do. */
  pure def defense(st: State): (str, State) = {
    val payout = Payout("defender")
    val ownA = st.queueA.length() > 0 and st.queueA[0].by == "defender"
    val ownC = st.queueC.length() > 0 and st.queueC[0].by == "defender"
    val fixGuardian = SetGuardian(goodG(st))
    val fixHot = RecoverApp("H2")
    if (lastForeign(st.queueA, canCancelA(st, "attacker")) >= 0 and canCancelA(st, "defender"))
      ("cancel", { ...st, queueA: dropFirst(st.queueA, lastForeign(st.queueA, canCancelA(st, "attacker")) + 1) })
    else if (lastForeign(st.queueC, canCancelC(st, "attacker")) >= 0 and canCancelC(st, "defender"))
      ("cancel", { ...st, queueC: dropFirst(st.queueC, lastForeign(st.queueC, canCancelC(st, "attacker")) + 1) })
    // The Council replaces any key the attacker holds on the Vault Delay, the cancel role or the Council, at once.
    else if (guarded(st) and attackerOnKeys(st) and controls(st, "defender") and st.councilRole)
      ("rekey now", councilRekey(st, goodH(st), goodG(st)))
    // The guardian side is not clean (lost, hostile or leaked guardian, or an old guardian still on the
    // Recovery Delay): H replaces the guardian everywhere through the Vault Delay.
    else if (guarded(st) and only(st, st.hot) and not(guardianClean(st))
             and not(pending(st.queueA, fixGuardian)) and st.queueA.length() < MAX_QUEUE)
      ("queue guardian swap", { ...st, queueA: enqueue(st.queueA, fixGuardian, st.time, "defender") })
    // Without the hot key: the guardian starts a recovery on the Recovery Delay.
    else if (recoveryOn(st) and not(holds(st, "defender", st.hot)) and canQueueC(st, "defender")
             and not(pending(st.queueC, fixHot)) and st.queueC.length() < MAX_QUEUE)
      ("queue recovery", { ...st, queueC: enqueue(st.queueC, fixHot, st.time, "defender") })
    else if (ownC and ready(st, st.queueC[0], RECOVERY))
      ("execute", { ...apply(st, st.queueC[0].eff), queueC: dropFirst(st.queueC, 1) })
    else if (ownA and ready(st, st.queueA[0], st.cooldownA))
      ("execute", { ...apply(st, st.queueA[0].eff), queueA: dropFirst(st.queueA, 1) })
    // Simple setup: the only way to change keys is the vault queue, which a leaked key can cancel.
    else if (not(guarded(st)) and attackerPowerful(st) and canQueueA(st, "defender")
             and not(pending(st.queueA, Rekey({ h: goodH(st), g: "" }))) and st.queueA.length() < MAX_QUEUE)
      ("queue rekey on the vault", { ...st, queueA: enqueue(st.queueA, Rekey({ h: goodH(st), g: "" }), st.time, "defender") })
    else if (recovered(st) and st.funds == "vault" and not(pending(st.queueA, payout)) and st.queueA.length() < MAX_QUEUE)
      ("queue withdrawal", { ...st, queueA: enqueue(st.queueA, payout, st.time, "defender") })
    else ("none", st)
  }

  // ---------------------------------------------------------------------
  // Steps
  // ---------------------------------------------------------------------

  action defend = {
    val r = defense(s)
    all { r._1 != "none", s' = r._2 }
  }

  pure val ATTACK_A = Set(Payout("attacker"), SetCooldownA(0), SetCouncilRole(false), SetGuardian("GA"), Rekey({ h: "HA", g: "GA" }))

  action attackQueueA = {
    nondet e = ATTACK_A.oneOf()
    all { canQueueA(s, "attacker"), s.queueA.length() < MAX_QUEUE, s' = { ...s, queueA: enqueue(s.queueA, e, s.time, "attacker") } }
  }
  action attackQueueC = all {
    canQueueC(s, "attacker"), s.queueC.length() < MAX_QUEUE, s' = { ...s, queueC: enqueue(s.queueC, Recover("HA"), s.time, "attacker") },
  }
  action attackCancel = {
    nondet n = 1.to(MAX_QUEUE).oneOf()
    any {
      all { canCancelA(s, "attacker"), n <= s.queueA.length(), s' = { ...s, queueA: dropFirst(s.queueA, n) } },
      all { canCancelC(s, "attacker"), n <= s.queueC.length(), s' = { ...s, queueC: dropFirst(s.queueC, n) } },
    }
  }
  action attackRekeyNow = all { guarded(s), controls(s, "attacker"), s' = councilRekey(s, "HA", "GA") }

  /** Anyone may execute the oldest ready item of any queue, or skip an expired one. */
  action execute = any {
    all { s.queueA.length() > 0, ready(s, s.queueA[0], s.cooldownA), s' = { ...apply(s, s.queueA[0].eff), queueA: dropFirst(s.queueA, 1) } },
    all { s.queueA.length() > 0, expired(s, s.queueA[0], s.cooldownA), s' = { ...s, queueA: dropFirst(s.queueA, 1) } },
    all { s.queueC.length() > 0, ready(s, s.queueC[0], RECOVERY), s' = { ...apply(s, s.queueC[0].eff), queueC: dropFirst(s.queueC, 1) } },
    all { s.queueC.length() > 0, expired(s, s.queueC[0], RECOVERY), s' = { ...s, queueC: dropFirst(s.queueC, 1) } },
  }

  /**
   * A day passes only when the defender has done every duty except
   * cancelling foreign items that are still young (they may sit until they
   * would be older than RESPONSE). Without this, an attacker who re-queues
   * after every cancel would starve the defender's key swap.
   */
  pure def young(st: State, l: List[Item], attackerCanCancel: bool): List[Item] =
    range(0, l.length()).foldl(List(), (acc, i) =>
      if (l[i].by == "defender" or (not(attackerCanCancel) and i > firstOwn(l)) or age(st, l[i]) + DAY > RESPONSE) acc.append(l[i]) else acc)
  pure def mayTick(st: State): bool = {
    val sleepy = {
      ...st,
      queueA: young(st, st.queueA, canCancelA(st, "attacker")),
      queueC: young(st, st.queueC, canCancelC(st, "attacker")),
    }
    defense(sleepy)._1 == "none"
  }

  action tick = {
    val t = s.time + DAY
    val released = s.scenario == "coercion" and s.time < COERCION and t >= COERCION
    all {
      t <= HORIZON,
      mayTick(s),
      s' = {
        ...s,
        time: t,
        attacker: if (released) s.attacker.exclude(Set("H")) else s.attacker,
        defender: if (released) s.defender.union(Set("H")) else s.defender,
      },
    }
  }

  action step = any { defend, attackQueueA, attackQueueC, attackCancel, attackRekeyNow, execute, tick }

  // ---------------------------------------------------------------------
  // Setups and scenarios
  // ---------------------------------------------------------------------

  pure def start(setup: str, scenario: str): State = {
    val guardian = setup != "simple"
    val allKeys = Set("H", "H2").union(if (guardian) Set("G", "G2") else Set())
    val defender =
      if (scenario == "guardianHostileHotLost") allKeys.exclude(Set("G", "H"))
      else if (scenario == "guardianHostile" or scenario == "guardianLost") allKeys.exclude(Set("G"))
      else if (scenario == "hotKeyLost" or scenario == "coercion" or scenario == "hotKeyTaken") allKeys.exclude(Set("H"))
      else allKeys
    val stolen =
      if (scenario == "hotKeyLeak" or scenario == "coercion" or scenario == "hotKeyTaken") Set("H")
      else if (scenario == "guardianHostile" or scenario == "guardianLeak" or scenario == "guardianHostileHotLost") Set("G")
      else if (scenario == "bothKeys") Set("H", "G")
      else Set()
    {
      setup: setup, scenario: scenario, time: 0, funds: "vault", cooldownA: COOLDOWN_A,
      hot: "H",
      cancelers: if (guardian) Set("H", "G") else Set("H"),
      owners: if (guardian) Set("H", "G") else Set(),
      recMod: if (setup == "guardianRecovery") "G" else "",
      councilRole: guardian,
      queueA: List(), queueC: List(),
      defender: defender, attacker: Set("HA", "GA").union(stolen),
    }
  }

  // One init per (setup, scenario), so each can be checked on its own (see compare.mjs).
  action init_simple_none = s' = start("simple", "none")
  action init_simple_coercion = s' = start("simple", "coercion")
  action init_simple_hotKeyLeak = s' = start("simple", "hotKeyLeak")
  action init_simple_hotKeyLost = s' = start("simple", "hotKeyLost")
  action init_simple_hotKeyTaken = s' = start("simple", "hotKeyTaken")
  action init_guardianVeto_none = s' = start("guardianVeto", "none")
  action init_guardianVeto_coercion = s' = start("guardianVeto", "coercion")
  action init_guardianVeto_hotKeyLeak = s' = start("guardianVeto", "hotKeyLeak")
  action init_guardianVeto_hotKeyTaken = s' = start("guardianVeto", "hotKeyTaken")
  action init_guardianVeto_hotKeyLost = s' = start("guardianVeto", "hotKeyLost")
  action init_guardianVeto_guardianHostile = s' = start("guardianVeto", "guardianHostile")
  action init_guardianVeto_guardianLost = s' = start("guardianVeto", "guardianLost")
  action init_guardianVeto_bothKeys = s' = start("guardianVeto", "bothKeys")
  action init_guardianVeto_guardianLeak = s' = start("guardianVeto", "guardianLeak")
  action init_guardianRecovery_none = s' = start("guardianRecovery", "none")
  action init_guardianRecovery_coercion = s' = start("guardianRecovery", "coercion")
  action init_guardianRecovery_hotKeyLeak = s' = start("guardianRecovery", "hotKeyLeak")
  action init_guardianRecovery_hotKeyTaken = s' = start("guardianRecovery", "hotKeyTaken")
  action init_guardianRecovery_hotKeyLost = s' = start("guardianRecovery", "hotKeyLost")
  action init_guardianRecovery_guardianLeak = s' = start("guardianRecovery", "guardianLeak")
  action init_guardianRecovery_guardianHostile = s' = start("guardianRecovery", "guardianHostile")
  action init_guardianRecovery_guardianLost = s' = start("guardianRecovery", "guardianLost")
  action init_guardianRecovery_bothKeys = s' = start("guardianRecovery", "bothKeys")
  action init_guardianRecovery_guardianHostileHotLost = s' = start("guardianRecovery", "guardianHostileHotLost")
  action init_guardianVeto_guardianHostileHotLost = s' = start("guardianVeto", "guardianHostileHotLost")

  action init = s' = start("guardianVeto", "hotKeyLeak")

  // ---------------------------------------------------------------------
  // Properties (checked over every reachable state up to HORIZON)
  // ---------------------------------------------------------------------

  /** P1 No theft: the attacker never receives the funds. */
  val noTheft = s.funds != "attacker"

  /** P2 Recovers: within one delay (with recovery: within the recovery wait), the defender alone holds every key with power again. */
  pure def deadline(st: State): int = if (recoveryOn(st)) RECOVERY else DELAY
  // At the deadline itself the defender may still be acting (an item that becomes ready runs in
  // that moment), but time cannot move past the deadline unless the property holds.
  val recovers = s.time < deadline(s) or recovered(s) or not(mayTick(s))

  /** P3 Can withdraw: within two delays, the defender has the funds out. */
  val withdraws = s.time < deadline(s) + DELAY or s.funds == "defender" or not(mayTick(s))
}
