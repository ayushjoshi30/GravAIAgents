"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api, type ApiFailure, type ApiResult, type ReadinessOut } from "./api";
import { useToken } from "./session";

/**
 * Fetch-with-fallback for every console screen.
 *
 * `mode` is the honest answer to "is what I am looking at real?":
 *   live    — this came from the API for the token you supplied
 *   example — the API could not answer, so this is illustrative data
 *   loading — we do not know yet
 *
 * Screens are required to surface `mode`. Nothing in this console shows an
 * example figure without saying it is one.
 */

export type DataMode = "loading" | "live" | "example";

export interface Resource<T> {
  data: T;
  mode: DataMode;
  failure: ApiFailure | null;
  reload: () => void;
}

export function useResource<T>(
  key: string,
  fetcher: (signal: AbortSignal) => Promise<ApiResult<T>>,
  example: T,
): Resource<T> {
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const exampleRef = useRef(example);
  exampleRef.current = example;

  const [state, setState] = useState<{
    data: T;
    mode: DataMode;
    failure: ApiFailure | null;
  }>({ data: example, mode: "loading", failure: null });

  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;

    setState((previous) => ({ ...previous, mode: "loading" }));

    fetcherRef
      .current(controller.signal)
      .then((result) => {
        if (cancelled) return;
        if (result.ok) {
          setState({ data: result.data, mode: "live", failure: null });
        } else {
          setState({ data: exampleRef.current, mode: "example", failure: result });
        }
      })
      .catch(() => {
        if (cancelled) return;
        setState({
          data: exampleRef.current,
          mode: "example",
          failure: {
            ok: false,
            kind: "unreachable",
            message: "The request could not be completed.",
          },
        });
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [key, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  return { ...state, reload };
}

export interface ConnectionState {
  status: "checking" | "connected" | "unreachable" | "no-token";
  readiness: ReadinessOut | null;
  checkedAt: Date | null;
  recheck: () => void;
}

/**
 * Liveness of the API, independent of whether a token is valid.
 * `/healthz` is public, so this distinguishes "API is down" from
 * "API is up and your token is wrong" — which are different problems.
 */
export function useConnection(): ConnectionState {
  const [token] = useToken();
  const [status, setStatus] = useState<ConnectionState["status"]>("checking");
  const [readiness, setReadiness] = useState<ReadinessOut | null>(null);
  const [checkedAt, setCheckedAt] = useState<Date | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;

    setStatus("checking");

    (async () => {
      const health = await api.health(controller.signal);
      if (cancelled) return;
      if (!health.ok) {
        setStatus("unreachable");
        setReadiness(null);
        setCheckedAt(new Date());
        return;
      }
      const ready = await api.readiness(controller.signal);
      if (cancelled) return;
      setReadiness(ready.ok ? ready.data : null);
      setStatus(token ? "connected" : "no-token");
      setCheckedAt(new Date());
    })();

    const interval = setInterval(() => setNonce((n) => n + 1), 60_000);
    return () => {
      cancelled = true;
      controller.abort();
      clearInterval(interval);
    };
  }, [token, nonce]);

  const recheck = useCallback(() => setNonce((n) => n + 1), []);

  return { status, readiness, checkedAt, recheck };
}
