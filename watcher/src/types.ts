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
};

export type Kind = 'withdrawal' | 'transfer_other' | 'delay' | 'handover' | 'guardian_add' | 'guardian_remove' | 'call' | 'unknown';

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
  outbox: Alert[];
  failCount: number;
  problemOpen: boolean;
  problemSince?: number;
  lastHeartbeat?: number;
  seq: number;
};
