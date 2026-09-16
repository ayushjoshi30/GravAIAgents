"use client";

import { useCallback, useSyncExternalStore } from "react";

/**
 * Console session state held in the browser.
 *
 * The bearer token never leaves this machine: it is pasted into Settings,
 * kept in localStorage, and attached to API calls made directly from the
 * browser to the GravAI API. There is no Next.js server route that proxies
 * it, so the token is never written to a server log.
 */

const TOKEN_KEY = "gravai.console.token";
const LABEL_KEY = "gravai.console.label";
const BASE_KEY = "gravai.console.apiBase";

type Listener = () => void;

const listeners = new Set<Listener>();

function emit(): void {
  listeners.forEach((listener) => listener());
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  if (typeof window !== "undefined") {
    window.addEventListener("storage", listener);
  }
  return () => {
    listeners.delete(listener);
    if (typeof window !== "undefined") {
      window.removeEventListener("storage", listener);
    }
  };
}

function read(key: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string | null): void {
  if (typeof window === "undefined") return;
  try {
    if (value === null || value === "") window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    /* Private browsing or storage disabled — the console still works, the
       token just does not survive a reload. */
  }
  emit();
}

export function getToken(): string | null {
  return read(TOKEN_KEY);
}

export function setToken(value: string | null): void {
  write(TOKEN_KEY, value ? value.trim() : null);
}

export function useToken(): [string | null, (value: string | null) => void] {
  const token = useSyncExternalStore(
    subscribe,
    () => read(TOKEN_KEY),
    () => null,
  );
  const update = useCallback((value: string | null) => setToken(value), []);
  return [token, update];
}

export function useSessionLabel(): [string | null, (value: string | null) => void] {
  const label = useSyncExternalStore(
    subscribe,
    () => read(LABEL_KEY),
    () => null,
  );
  const update = useCallback((value: string | null) => write(LABEL_KEY, value), []);
  return [label, update];
}

/** An operator can point the console at a different API without a rebuild. */
export function useApiBaseOverride(): [string | null, (value: string | null) => void] {
  const base = useSyncExternalStore(
    subscribe,
    () => read(BASE_KEY),
    () => null,
  );
  const update = useCallback((value: string | null) => write(BASE_KEY, value), []);
  return [base, update];
}

/**
 * Read the non-sensitive claims out of a JWT for display.
 * This is presentation only — the API validates the signature, never this.
 */
export interface TokenClaims {
  subject?: string;
  tenantId?: string;
  roles?: string[];
  scopes?: string[];
  expiresAt?: Date;
  expired?: boolean;
}

export function inspectToken(token: string | null): TokenClaims | null {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = payload + "=".repeat((4 - (payload.length % 4)) % 4);
    const json = JSON.parse(
      decodeURIComponent(
        atob(padded)
          .split("")
          .map((c) => `%${`00${c.charCodeAt(0).toString(16)}`.slice(-2)}`)
          .join(""),
      ),
    ) as Record<string, unknown>;

    const exp = typeof json.exp === "number" ? new Date(json.exp * 1000) : undefined;
    return {
      subject: typeof json.sub === "string" ? json.sub : undefined,
      tenantId:
        typeof json.tenant_id === "string"
          ? json.tenant_id
          : typeof json.tid === "string"
            ? json.tid
            : undefined,
      roles: Array.isArray(json.roles) ? (json.roles as string[]) : undefined,
      scopes: Array.isArray(json.scopes) ? (json.scopes as string[]) : undefined,
      expiresAt: exp,
      expired: exp ? exp.getTime() < Date.now() : undefined,
    };
  } catch {
    return null;
  }
}

/**
 * The shape the console shell and the redesign's components read.
 *
 * A convenience over `useToken` + `inspectToken`, added because the redesign's
 * components each need the same four facts about the session — is there a
 * token, whose tenant, which role, and is the API answering — and deriving
 * that in five places invites five slightly different answers to "are we
 * live?".
 *
 * `reachable` is deliberately tri-state. `undefined` means nobody has checked
 * yet, which is not the same as `false`; a shell that renders "Not reachable"
 * during the first round trip tells every user the product is broken once per
 * page load.
 */
export interface SessionView {
  token: string | null;
  claims: TokenClaims | null;
  tenantName?: string;
  roleLabel?: string;
  roles: string[];
  scopes: string[];
  reachable?: boolean;
}

/** Turn `underwriter` into `Underwriter`, `credit_head` into `Credit head`. */
function humanRole(role: string): string {
  const spaced = role.replace(/_/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

export function useSession(reachable?: boolean): SessionView {
  const [token] = useToken();
  const [label] = useSessionLabel();
  const claims = inspectToken(token);
  const roles = claims?.roles ?? [];

  return {
    token,
    claims,
    // A label the operator set wins over the tenant id, which is a UUID and
    // tells a human nothing.
    tenantName: label ?? claims?.tenantId,
    roleLabel: roles.length ? roles.map(humanRole).join(" · ") : undefined,
    roles,
    scopes: claims?.scopes ?? [],
    reachable,
  };
}

/** Whether this session may act on a queue, mirroring the approval matrix. */
export function canApprove(session: SessionView, queue: string): boolean {
  return session.roles.some((role) => APPROVER_QUEUES[role]?.includes(queue));
}

/**
 * Which queues each role may approve. The API enforces this; the console reads
 * it only to disable a control and say why, which is the difference between a
 * button that fails and a button that explains.
 */
export const APPROVER_QUEUES: Record<string, string[]> = {
  underwriter: ["underwriting.queue", "onboarding.queue"],
  credit_head: ["underwriting.queue", "credit.head", "onboarding.queue"],
  collections_manager: ["collections.manager"],
  ops: [],
  auditor: [],
};
