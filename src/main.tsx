import React, { useEffect, useState, type FormEvent } from "react";
import { createRoot } from "react-dom/client";
import {
  BrowserRouter,
  NavLink,
  Route,
  Routes,
  Link,
  Navigate,
  useLocation,
} from "react-router-dom";
import {
  LayoutDashboard,
  Heart,
  Ticket,
  History,
  ListOrdered,
  BarChart3,
  Dices,
  Settings,
  LogOut,
  ChevronRight,
  Menu,
  X,
  Eye,
  EyeOff,
  LoaderCircle,
} from "lucide-react";
import {
  api,
  AppProvider,
  useApp,
  useApi,
  syncPollingInterval,
  type Meta,
} from "./lib";
import { Dashboard, Favorites, Purchases } from "./pages/records";
import { HistoryPage, DrawsPage, StatisticsPage } from "./pages/analysis";
import { GeneratorPage } from "./pages/generator";
import { SettingsPage } from "./pages/settings";
import "./styles.css";
import "@fontsource-variable/noto-sans-kr";

const navigation = [
  { path: "/", name: "대시보드", icon: LayoutDashboard },
  { path: "/favorites", name: "나의 번호", icon: Heart },
  { path: "/purchases", name: "구입한 번호", icon: Ticket },
  { path: "/history", name: "과거 당첨 조회", icon: History },
  { path: "/draws", name: "회차별 결과", icon: ListOrdered },
  { path: "/statistics", name: "번호 통계", icon: BarChart3 },
  { path: "/generator", name: "번호 생성", icon: Dices },
  { path: "/settings", name: "설정", icon: Settings },
];
function Logo() {
  return (
    <span className="brand">
      <span className="brand-mark">
        6<span />
      </span>
      <span>로또 6/45</span>
    </span>
  );
}
function Root() {
  const [user, setUser] = useState<{ username: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  useEffect(() => {
    void api<{ user: { username: string } | null }>("/auth/session")
      .then((data) => setUser(data.user))
      .catch((error) => setError(error.message))
      .finally(() => setLoading(false));
    const expired = () => setUser(null);
    window.addEventListener("lotto:session-expired", expired);
    return () => window.removeEventListener("lotto:session-expired", expired);
  }, []);
  return (
    <AppProvider logout={() => setUser(null)}>
      {loading ? (
        <div className="boot-screen">
          <Logo />
          <LoaderCircle className="spin" />
        </div>
      ) : user ? (
        <Shell username={user.username} />
      ) : (
        <Login connectedError={error} done={setUser} />
      )}
    </AppProvider>
  );
}
function Login({
  done,
  connectedError,
}: {
  done: (user: { username: string }) => void;
  connectedError: string;
}) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const [error, setError] = useState(connectedError);
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const data = await api<{ user: { username: string } }>(
        "/auth/login",
        "POST",
        { username, password },
      );
      setPassword("");
      done(data.user);
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="login-page">
      <form onSubmit={submit} className="login-form">
        <label>
          아이디
          <input
            autoComplete="username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            maxLength={80}
            required
          />
        </label>
        <label>
          비밀번호
          <span className="password-field">
            <input
              type={show ? "text" : "password"}
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              maxLength={256}
              required
            />
            <button
              type="button"
              className="icon-button"
              aria-label={show ? "비밀번호 숨기기" : "비밀번호 표시"}
              onClick={() => setShow(!show)}
            >
              {show ? <EyeOff size={19} /> : <Eye size={19} />}
            </button>
          </span>
        </label>
        {error && (
          <p className="login-error" role="alert">
            {error}
          </p>
        )}
        <button className="button primary full login-submit" disabled={busy}>
          {busy ? <LoaderCircle size={18} className="spin" /> : "로그인"}
        </button>
      </form>
    </main>
  );
}
function Shell({ username }: { username: string }) {
  const [menu, setMenu] = useState(false);
  const location = useLocation();
  const { logout, toast } = useApp();
  const meta = useApi<Meta>("/meta", syncPollingInterval);
  useEffect(() => {
    setMenu(false);
  }, [location.pathname]);
  useEffect(() => {
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenu(false);
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, []);
  const current =
    navigation.find((n) => n.path === location.pathname)?.name ?? "로또 6/45";
  async function signout() {
    try {
      await api("/auth/logout", "POST", {});
      logout();
    } catch (error) {
      toast((error as Error).message, true);
    }
  }
  return (
    <div className="app-layout">
      {menu && (
        <button
          className="mobile-backdrop"
          aria-label="메뉴 닫기"
          onClick={() => setMenu(false)}
        />
      )}
      <aside className={"sidebar" + (menu ? " open" : "")}>
        <Link to="/" className="brand-link">
          <Logo />
        </Link>
        <button
          className="mobile-close icon-button"
          aria-label="메뉴 닫기"
          onClick={() => setMenu(false)}
        >
          <X size={22} />
        </button>
        <p className="nav-section">나의 기록</p>
        <nav aria-label="주 메뉴">
          {navigation.map((item, index) => (
            <React.Fragment key={item.path}>
              {index === 4 && (
                <p className="nav-section second">데이터와 도구</p>
              )}
              <NavLink
                to={item.path}
                end={item.path === "/"}
                className={({ isActive }) =>
                  "nav-link" + (isActive ? " active" : "")
                }
              >
                <item.icon size={19} />
                <span>{item.name}</span>
              </NavLink>
            </React.Fragment>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="data-badge">
            <span className="live-dot" />
            <div>
              <strong>
                {meta.data?.latestJob &&
                ["running", "queued"].includes(meta.data.latestJob.status)
                  ? "회차 수집 중"
                  : meta.data?.coverage.latest
                    ? `${meta.data.coverage.latest}회차까지 수집`
                    : "데이터 준비 중"}
              </strong>
              {!!meta.data?.coverage.missing.length && (
                <span>{meta.data.coverage.missing.length}회차 보충 필요</span>
              )}
            </div>
          </div>
          <div className="sidebar-account">
            <div className="avatar">{username.slice(0, 1).toUpperCase()}</div>
            <div>
              <strong>{username}</strong>
              <small>개인 계정</small>
            </div>
            <button
              className="icon-button"
              aria-label="로그아웃"
              onClick={() => void signout()}
            >
              <LogOut size={18} />
            </button>
          </div>
        </div>
      </aside>
      <div className="app-main">
        <header className="topbar">
          <div className="breadcrumb">
            <button
              className="mobile-menu icon-button"
              aria-label="메뉴 열기"
              onClick={() => setMenu(true)}
            >
              <Menu size={23} />
            </button>
            <span>로또 6/45</span>
            <ChevronRight size={14} />
            <strong>{current}</strong>
          </div>
        </header>
        <main className="main-content">
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/favorites" element={<Favorites />} />
            <Route path="/purchases" element={<Purchases />} />
            <Route path="/history" element={<HistoryPage />} />
            <Route path="/draws" element={<DrawsPage />} />
            <Route path="/statistics" element={<StatisticsPage />} />
            <Route path="/generator" element={<GeneratorPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
          <footer className="app-footer">
            <span>로또 6/45</span>
          </footer>
        </main>
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <Root />
    </BrowserRouter>
  </React.StrictMode>,
);
