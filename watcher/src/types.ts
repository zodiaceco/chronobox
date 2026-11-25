// What the watcher keeps about one vault, and what it sends.

export type Settings = {
  cooldown: string;
  expiration: string;
  controllers: string[];
  safeModules: string[];
  owner: string;
  avatar: string;
  target: string;
  // Only set when CHRONOBOX is known. '' / [] when the vault has no Roles modifier (no cancel).
  roles?: string;
  rolesOwner?: string;
  cancellers?: string[];
  /**
   * Only set when the vault has a cancel contract. Missing in a state from before the watcher knew of guardians: then
   * the first poll only learns them, and tells nothing.
   */
  guardian?: string; // '' without a guardian
  council?: string;
  councilOwners?: string[]; // [] while the Safe is not made
  councilThreshold?: string;
  councilModules?: string[];
  councilGuard?: string;
  recovery?: RecoverySettings;
};

/** The recovery Delay of a vault, as read. */
export type RecoverySettings = {
  delay: string;
  made: boolean;
  owner: string;
  avatar: string;
  target: string;
  guard?: string;
  /** Who can put something into its line. With the recovery on: the guardian, and nobody else. */
  modules: string[];
  cooldown: string;
  expiration: string;
};

export type Kind =
  | 'withdrawal' | 'transfer_other' | 'delay' | 'handover' | 'guardian_add' | 'guardian_remove'
  | 'recovery_on' | 'recovery_off' | 'recovery_wait' | 'recovery' | 'call' | 'unknown';

export type Item = {
  nonce: number;
  createdAt: string;
  block?: number;
  to?: string;
  value?: string;
  data?: string;
  operation?: number;
  kind: Kind;
  summary: string;
  detail: string;
  priority: number;
  /** A step in the line of the recovery: the wallet that it brings the Chronobox to, '' when it is not a recovery as the app makes it. */
  wallet?: string;
  sentReady?: boolean;
  sentExpiring?: boolean;
  sentExpired?: boolean;
};

export type Alert = {
  id: string;
  event: string;
  title: string;
  message: string;
  priority: number;
  nonce?: number;
  at: number;
  done: string[];
};

export type State = {
  version: 1;
  chainId?: number;
  delay?: string;
  vault?: string;
  lastBlock?: number;
  txNonce?: number;
  queueNonce?: number;
  settings?: Settings;
  items: Record<string, Item>;
  /** The line of the recovery Delay, while it can act. Missing in a state from before the watcher knew of it. */
  recoveryTxNonce?: number;
  recoveryQueueNonce?: number;
  recoveryItems?: Record<string, Item>;
  outbox: Alert[];
  failCount: number;
  problemOpen: boolean;
  problemSince?: number;
  lastHeartbeat?: number;
  seq: number;
};
