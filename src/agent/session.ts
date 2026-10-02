import { randomUUID } from 'node:crypto';
import type { Message } from '../llm/adapter.js';

export interface VisibleCall {
  name: string;
  args: unknown;
  result: string;
}
export interface ChatResult {
  sessionId: string;
  reply: string;
  toolCalls: VisibleCall[];
  needsConfirmation: boolean;
}
export interface HistoryEntry {
  role: 'user' | 'assistant';
  content: string;
  toolCalls?: VisibleCall[];
  needsConfirmation?: boolean;
}
export interface Session {
  id: string;
  history: HistoryEntry[];
  turns: Message[][];
  selectedCase?: string;
  pending?: { caso: string; reasons: string[] };
  budgetTokens: number;
  usedTokens: number;
  busy: boolean;
  touched: number;
}
export class SessionStore {
  private readonly sessions = new Map<string, Session>();
  constructor(
    private readonly maxSessions = 100,
    private readonly ttlMs = 3600000,
  ) {}
  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }
  obtain(id?: string): Session {
    for (const [key, session] of this.sessions) {
      if (!session.busy && Date.now() - session.touched > this.ttlMs) this.sessions.delete(key);
    }
    if (id) {
      const session = this.sessions.get(id);
      if (!session) throw new Error('La sesión no existe o expiró. Inicia una nueva conversación.');
      return session;
    }
    if (this.sessions.size >= this.maxSessions)
      throw new Error('Se alcanzó el límite de sesiones. Intenta más tarde.');
    const session: Session = {
      id: randomUUID(),
      history: [],
      turns: [],
      budgetTokens: 0,
      usedTokens: 0,
      busy: false,
      touched: Date.now(),
    };
    this.sessions.set(session.id, session);
    return session;
  }
}
