import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

export async function api<T>(
  path: string,
  method = "GET",
  body?: unknown,
  options: { signal?: AbortSignal } = {},
): Promise<T> {
  const response = await fetch("/api" + path, {
    method,
    signal: options.signal,
    credentials: "same-origin",
    headers:
      body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({
    error: "서버에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.",
  }));
  if (!response.ok) {
    if (response.status === 401 && path !== "/auth/login")
      window.dispatchEvent(new Event("lotto:session-expired"));
    throw new Error(
      data.error + (data.details?.length ? " " + data.details[0] : ""),
    );
  }
  return data;
}
export const money = (value: number | null | undefined) =>
  value === null || value === undefined
    ? "미확정"
    : value.toLocaleString("ko-KR") + "원";
export const dateLabel = (value: string) => value.replaceAll("-", ".");
export const timeLabel = (value: string) =>
  new Date(value).toLocaleString("ko-KR", {
    timeZone: "Asia/Seoul",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
export interface Meta {
  nextRound: number;
  nextDate: string;
  today: string;
  coverage: {
    total: number;
    complete: number;
    latest: number;
    missing: number[];
  };
  latestJob: import("../shared/domain").SyncJob | null;
}
const Context = createContext<{
  revision: number;
  refresh: () => void;
  toast: (message: string, error?: boolean) => void;
  logout: () => void;
}>({ revision: 0, refresh() {}, toast() {}, logout() {} });
export function AppProvider({
  children,
  logout,
}: {
  children: ReactNode;
  logout: () => void;
}) {
  const [revision, setRevision] = useState(0);
  const [message, setMessage] = useState<{
    text: string;
    error: boolean;
  } | null>(null);
  useEffect(() => {
    if (!message) return;
    const timer = setTimeout(() => setMessage(null), 5000);
    return () => clearTimeout(timer);
  }, [message]);
  return (
    <Context.Provider
      value={{
        revision,
        refresh: () => setRevision((n) => n + 1),
        toast: (text, error = false) => setMessage({ text, error }),
        logout,
      }}
    >
      {children}
      {message && (
        <div
          className={"toast" + (message.error ? " error" : "")}
          role={message.error ? "alert" : "status"}
        >
          {message.text}
          <button aria-label="알림 닫기" onClick={() => setMessage(null)}>
            ×
          </button>
        </div>
      )}
    </Context.Provider>
  );
}
export const useApp = () => useContext(Context);
export function syncPollingInterval(
  data: {
    latestJob?: Meta["latestJob"];
    jobs?: import("../shared/domain").SyncJob[];
  } | null,
) {
  const jobs = data?.jobs ?? (data?.latestJob ? [data.latestJob] : []);
  return jobs.some((job) => ["queued", "running"].includes(job.status))
    ? 10_000
    : 600_000;
}
export function useApi<T>(
  path: string,
  polling: false | number | ((data: T | null) => number) = false,
) {
  const { revision } = useApp();
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let latestResult: T | null = null;
    const load = async () => {
      try {
        const result = await api<T>(path);
        if (!cancelled) {
          latestResult = result;
          setData(result);
          setError("");
        }
      } catch (error) {
        if (!cancelled)
          setError(
            error instanceof Error
              ? error.message
              : "조회 중 오류가 발생했습니다.",
          );
      } finally {
        if (!cancelled) {
          setLoading(false);
          if (polling !== false) {
            const interval =
              typeof polling === "function" ? polling(latestResult) : polling;
            timer = setTimeout(load, interval);
          }
        }
      }
    };
    setLoading(true);
    void load();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [path, revision, polling]);
  return { data, error, loading };
}
export function useAction() {
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState("");
  const { toast } = useApp();
  const run = async (action: () => Promise<unknown>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (cause) {
      const message =
        cause instanceof Error ? cause.message : "요청을 처리하지 못했습니다.";
      setError(message);
      toast(message, true);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  return { busy, error, clearError: () => setError(""), run };
}
export async function download(path: string) {
  const response = await fetch("/api" + path, { credentials: "same-origin" });
  if (!response.ok)
    throw new Error("파일을 내려받지 못했습니다. 로그인 상태를 확인해 주세요.");
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = path.includes("csv")
    ? "lotto-purchases.csv"
    : "lotto-backup-" + new Date().toISOString().slice(0, 10) + ".json";
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
