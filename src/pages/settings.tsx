import { useRef, useState, type FormEvent } from "react";
import {
  RefreshCw,
  Database,
  Download,
  Upload,
  ShieldCheck,
  Check,
  LoaderCircle,
  CalendarDays,
  CircleCheck,
  CircleAlert,
  Clock,
  HardDrive,
  ChevronDown,
} from "lucide-react";
import type { Settings, SyncJob } from "../../shared/domain";
import {
  api,
  useApi,
  useApp,
  useAction,
  download,
  timeLabel,
  syncPollingInterval,
} from "../lib";
import { PageTitle, Loading, ErrorBox, Dialog } from "../components";

interface SettingsData {
  settings: Settings;
  coverage: {
    total: number;
    complete: number;
    latest: number;
    missing: number[];
  };
  latestJob: SyncJob | null;
  backups: { name: string; createdAt: string; size: number }[];
}
const modeLabel: Record<SyncJob["mode"], string> = {
  initial: "최초 데이터 가져오기",
  latest: "최신 회차 갱신",
  missing: "누락 회차 보충",
  range: "지정 범위 재조회",
};
const statusLabel: Record<SyncJob["status"], string> = {
  queued: "대기 중",
  running: "수집 중",
  completed: "완료",
  partial: "일부 확인 필요",
  failed: "실패",
};
export function SettingsPage() {
  const { data, error, loading } = useApi<SettingsData>(
    "/settings",
    syncPollingInterval,
  );
  const [from, setFrom] = useState("1");
  const [to, setTo] = useState("");
  const [password, setPassword] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [restore, setRestore] = useState<{
    backup: Record<string, unknown>;
    name: string;
  } | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const action = useAction();
  const { refresh, toast } = useApp();
  const active =
    data?.latestJob && ["queued", "running"].includes(data.latestJob.status)
      ? data.latestJob
      : null;
  function sync(mode: SyncJob["mode"]) {
    void action.run(async () => {
      await api("/sync", "POST", {
        mode,
        ...(mode === "range"
          ? { from: Number(from), to: Number(to || data?.coverage.latest) }
          : {}),
      });
      // 수동 수집 직후에는 대기 중인 조회 타이머를 취소하고 즉시 상태를 확인합니다.
      refresh();
      toast("수집 작업을 시작했습니다. 진행 상황을 아래에서 확인하세요.");
    });
  }
  async function chooseBackup(chosen?: File) {
    if (!chosen) return;
    if (chosen.size > 10 * 1024 * 1024) {
      toast("10MB 이하의 JSON 백업을 선택해 주세요.", true);
      return;
    }
    try {
      const backup = JSON.parse(await chosen.text());
      if (
        ![1, 2].includes(backup.schemaVersion) ||
        !Array.isArray(backup.favorites) ||
        !Array.isArray(backup.purchases)
      )
        throw new Error("로또 6/45 JSON 백업 파일이 아닙니다.");
      action.clearError();
      setRestore({ backup, name: chosen.name });
    } catch (error) {
      toast(
        error instanceof Error ? error.message : "백업을 읽지 못했습니다.",
        true,
      );
    } finally {
      if (file.current) file.current.value = "";
    }
  }
  return (
    <>
      <PageTitle
        eyebrow="PREFERENCES & DATA"
        title="설정"
        description="회차 데이터를 최신으로 유지하고, 나의 기록을 안전하게 관리하세요."
      />
      {error && <ErrorBox error={error} />}
      {!data && loading ? (
        <Loading />
      ) : (
        data && (
          <>
            <section className="card data-health">
              <div className="health-icon">
                <Database size={26} />
              </div>
              <div>
                <h2>내 회차 데이터</h2>
                <p>1회부터 제 {data.coverage.latest || "—"}회까지</p>
              </div>
              <div className="health-counts">
                <div>
                  <strong>{data.coverage.total.toLocaleString()}</strong>
                  <span>수집 회차</span>
                </div>
                <div>
                  <strong>{data.coverage.complete.toLocaleString()}</strong>
                  <span>결과 확정</span>
                </div>
                <div>
                  <strong
                    className={
                      data.coverage.missing.length ? "text-amber" : "text-teal"
                    }
                  >
                    {data.coverage.missing.length}
                  </strong>
                  <span>누락 회차</span>
                </div>
              </div>
            </section>
            <section className="card settings-section">
              <div className="section-top">
                <div>
                  <h2>데이터 가져오기</h2>
                  <p className="muted">
                    초기 원본은 GitHub, 최신 결과는 동행복권 공식 API를
                    사용합니다.
                  </p>
                </div>
                {active && (
                  <span className="badge status-tallying">
                    <LoaderCircle size={13} className="spin" />
                    작업 진행 중
                  </span>
                )}
              </div>
              <div className="sync-options">
                <SyncOption
                  icon={<Database size={22} />}
                  title="최초 데이터"
                  description="1회부터 최신까지 전체 원본을 가져옵니다."
                  button="전체 가져오기"
                  disabled={action.busy || !!active}
                  click={() => sync("initial")}
                />
                <SyncOption
                  icon={<RefreshCw size={22} />}
                  title="최신 회차"
                  description="최근 회차 결과를 확인하고 누락 회차도 채웁니다."
                  button="최신으로 갱신"
                  disabled={action.busy || !!active}
                  click={() => sync("latest")}
                />
                <SyncOption
                  icon={<CircleCheck size={22} />}
                  title="누락 회차"
                  description="결과가 미확정인 회차를 보충합니다."
                  button="누락 회차 보충"
                  disabled={action.busy || !!active}
                  click={() => sync("missing")}
                />
              </div>
              <div className="range-sync">
                <div>
                  <strong>특정 범위 재조회</strong>
                  <p>과거 데이터의 수정 사항을 다시 확인할 때 사용하세요.</p>
                </div>
                <label>
                  <span className="sr-only">재조회 시작 회차</span>
                  <input
                    type="number"
                    min={1}
                    value={from}
                    onChange={(e) => setFrom(e.target.value)}
                  />
                </label>
                <span>~</span>
                <label>
                  <span className="sr-only">재조회 종료 회차</span>
                  <input
                    type="number"
                    min={1}
                    value={to || data.coverage.latest || ""}
                    onChange={(e) => setTo(e.target.value)}
                  />
                </label>
                <span>회</span>
                <button
                  className="button subtle"
                  disabled={action.busy || !!active}
                  onClick={() => sync("range")}
                >
                  재조회
                </button>
              </div>
              {data.coverage.missing.length > 0 && (
                <p className="footnote text-amber">
                  누락: {data.coverage.missing.slice(0, 30).join(", ")}
                  {data.coverage.missing.length > 30
                    ? " 외 " + (data.coverage.missing.length - 30) + "회차"
                    : ""}
                </p>
              )}
            </section>
            <section className="card settings-section">
              <div className="toggle-row">
                <div className="inline">
                  <span className="setting-icon">
                    <CalendarDays size={23} />
                  </span>
                  <div>
                    <h2>자동 갱신</h2>
                    <p className="muted">
                      사이트를 닫아도 서버에서 회차 데이터를 가져옵니다.
                    </p>
                  </div>
                </div>
                <button
                  className={"switch" + (data.settings.autoSync ? " on" : "")}
                  role="switch"
                  aria-label="회차 자동 갱신"
                  aria-checked={data.settings.autoSync}
                  disabled={action.busy}
                  onClick={() =>
                    void action.run(async () => {
                      await api("/settings", "PUT", {
                        autoSync: !data.settings.autoSync,
                      });
                      refresh();
                      toast(
                        data.settings.autoSync
                          ? "자동 갱신을 껐습니다."
                          : "자동 갱신을 켰습니다.",
                      );
                    })
                  }
                >
                  <span />
                </button>
              </div>
              <div className="schedule-info">
                <Clock size={18} />
                <div>
                  <strong>토요일 20:45 ~ 일요일 02:45 · 15분마다</strong>
                  <span>매일 03:00 추가 확인 · 한국 시간</span>
                </div>
                <span className="badge neutral">Asia/Seoul</span>
              </div>
            </section>
            <div className="settings-bottom-grid">
              <section className="card settings-section">
                <div className="section-top">
                  <div>
                    <h2>백업과 복원</h2>
                    <p className="muted">
                      번호·구매 기록·설정을 JSON 파일에 담습니다.
                    </p>
                  </div>
                  <HardDrive size={21} className="muted" />
                </div>
                <div className="backup-buttons">
                  <button
                    className="button primary-soft"
                    disabled={action.busy}
                    onClick={() => void action.run(() => download("/backup"))}
                  >
                    <Download size={17} />
                    JSON 백업
                  </button>
                  <button
                    className="button subtle"
                    onClick={() => file.current?.click()}
                  >
                    <Upload size={17} />
                    백업 복원
                  </button>
                  <input
                    ref={file}
                    className="sr-only"
                    type="file"
                    accept="application/json,.json"
                    onChange={(e) => void chooseBackup(e.target.files?.[0])}
                  />
                </div>
                <div className="server-backup">
                  <span className="inline">
                    <ShieldCheck size={16} />
                    서버 DB 백업 · 매일 03:30 / 최근 14개 보관
                  </span>
                  <button
                    className="text-link"
                    disabled={action.busy}
                    onClick={() =>
                      void action.run(async () => {
                        await api("/backup/snapshot", "POST", {});
                        refresh();
                        toast("서버 DB 백업을 생성했습니다.");
                      })
                    }
                  >
                    지금 백업
                  </button>
                </div>
                {data.backups[0] && (
                  <p className="footnote">
                    최근 백업 {timeLabel(data.backups[0].createdAt)} ·{" "}
                    {(data.backups[0].size / 1024).toFixed(0)} KB
                  </p>
                )}
              </section>
              <section className="card settings-section">
                <div className="section-top">
                  <div>
                    <h2>계정 관리</h2>
                    <p className="muted">나만 사용하는 로또 6/45</p>
                  </div>
                  <ShieldCheck size={21} className="muted" />
                </div>
                <div className="account-row">
                  <div className="avatar">T</div>
                  <div>
                    <strong>textimage</strong>
                    <span>개인 계정</span>
                  </div>
                  <button
                    className="button subtle"
                    onClick={() => setPassword(true)}
                  >
                    비밀번호 변경
                  </button>
                </div>
                <p className="footnote">
                  계정 변경은 현재 비밀번호 확인 후 적용됩니다.
                </p>
              </section>
            </div>
            <details
              className="card settings-section sync-history"
              onToggle={(event) => setHistoryOpen(event.currentTarget.open)}
            >
              <summary className="section-top sync-history-summary">
                <h2>수집 실행 내역</h2>
                <ChevronDown
                  size={18}
                  className={historyOpen ? "expanded" : ""}
                />
              </summary>
              {historyOpen && <SyncHistory />}
            </details>
          </>
        )
      )}
      {password && <PasswordDialog close={() => setPassword(false)} />}
      {restore && (
        <Dialog
          title="백업 복원 확인"
          description={restore.name}
          close={() => setRestore(null)}
        >
          <div className="form-stack">
            <p>
              나의 번호 {(restore.backup.favorites as unknown[]).length}개와
              구매 기록 {(restore.backup.purchases as unknown[]).length}건을
              복원합니다.
            </p>
            <div className="error-box">
              현재 개인 번호·구매 기록·설정이 이 백업의 내용으로 교체됩니다.
              먼저 현재 JSON 백업을 내려받을 수 있습니다.
            </div>
            <button
              className="button subtle"
              onClick={() => void action.run(() => download("/backup"))}
            >
              <Download size={17} />
              현재 기록 백업
            </button>
            {action.error && <ErrorBox error={action.error} />}
            <div className="form-footer">
              <button
                className="button subtle"
                onClick={() => setRestore(null)}
              >
                취소
              </button>
              <button
                className="button primary"
                disabled={action.busy}
                onClick={() =>
                  void action.run(async () => {
                    await api("/backup/restore", "POST", {
                      confirmed: true,
                      backup: restore.backup,
                    });
                    refresh();
                    toast("백업을 복원했습니다.");
                    setRestore(null);
                  })
                }
              >
                확인하고 복원
              </button>
            </div>
          </div>
        </Dialog>
      )}
    </>
  );
}
function SyncOption({
  icon,
  title,
  description,
  button,
  disabled,
  click,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  button: string;
  disabled: boolean;
  click: () => void;
}) {
  return (
    <div className="sync-option">
      <span className="sync-icon">{icon}</span>
      <h3>{title}</h3>
      <p>{description}</p>
      <button
        className="button subtle full"
        disabled={disabled}
        onClick={click}
      >
        {button}
      </button>
    </div>
  );
}

function SyncHistory() {
  const { data, error, loading } = useApi<{ jobs: SyncJob[] }>(
    "/settings/jobs",
    syncPollingInterval,
  );
  if (loading && !data)
    return (
      <div className="loading" role="status">
        <LoaderCircle className="spin" size={22} /> 수집 내역을 불러오는 중입니다.
      </div>
    );
  if (error) return <ErrorBox error={error} />;
  if (!data) return null;
  return (
    <div className="job-list">
      {data.jobs.slice(0, 10).map((job) => (
        <div className="job" key={job.id}>
          <div className="job-heading">
            <div className="inline">
              {job.status === "running" || job.status === "queued" ? (
                <LoaderCircle className="spin text-teal" size={18} />
              ) : job.status === "completed" ? (
                <CircleCheck className="text-teal" size={18} />
              ) : (
                <CircleAlert className="text-amber" size={18} />
              )}
              <strong>{modeLabel[job.mode]}</strong>
              <span
                className={
                  "badge " +
                  (job.status === "completed" ? "neutral" : "status-tallying")
                }
              >
                {statusLabel[job.status]}
              </span>
            </div>
            <span className="muted">{timeLabel(job.createdAt)}</span>
          </div>
          <div
            className="progress"
            role="progressbar"
            aria-label="회차 수집 진행률"
            aria-valuenow={job.processed}
            aria-valuemax={Math.max(1, job.total)}
            aria-valuemin={0}
          >
            <span
              style={{
                width: `${job.total ? Math.min(100, (job.processed / job.total) * 100) : 0}%`,
              }}
            />
          </div>
          <div className="job-meta">
            <span>
              {job.processed.toLocaleString()} / {job.total.toLocaleString()} 처리 ·
              {" "}저장·갱신 {job.saved.toLocaleString()}회
            </span>
            <span>
              {job.fallbackCount > 0
                ? `GitHub 대체 수집 ${job.fallbackCount}회`
                : "원본 검증 적용"}
            </span>
          </div>
          {job.errors.length > 0 && (
            <details className="job-errors">
              <summary>확인할 내용 {job.errors.length}건</summary>
              <ul>
                {job.errors.map((jobError, i) => (
                  <li key={i}>{jobError}</li>
                ))}
              </ul>
            </details>
          )}
        </div>
      ))}
      {!data.jobs.length && (
        <p className="muted">아직 실행된 수집 작업이 없습니다.</p>
      )}
    </div>
  );
}

function PasswordDialog({ close }: { close: () => void }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const action = useAction();
  const { toast, logout } = useApp();
  function submit(event: FormEvent) {
    event.preventDefault();
    void action.run(async () => {
      if (next !== confirmPassword)
        throw new Error("새 비밀번호와 확인 값이 다릅니다.");
      await api("/auth/password", "POST", {
        currentPassword: current,
        newPassword: next,
      });
      toast("비밀번호를 변경했습니다. 새 비밀번호로 다시 로그인해 주세요.");
      close();
      logout();
    });
  }
  return (
    <Dialog
      title="비밀번호 변경"
      description="변경 후 모든 로그인 세션이 종료됩니다."
      close={close}
    >
      <form onSubmit={submit} className="form-stack">
        <label>
          현재 비밀번호
          <input
            type="password"
            autoComplete="current-password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
            required
          />
        </label>
        <label>
          새 비밀번호
          <input
            type="password"
            autoComplete="new-password"
            minLength={8}
            maxLength={256}
            value={next}
            onChange={(e) => setNext(e.target.value)}
            required
          />
        </label>
        <label>
          새 비밀번호 확인
          <input
            type="password"
            autoComplete="new-password"
            minLength={8}
            maxLength={256}
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            required
          />
        </label>
        {action.error && <ErrorBox error={action.error} />}
        <div className="form-footer">
          <button className="button subtle" type="button" onClick={close}>
            취소
          </button>
          <button className="button primary" disabled={action.busy}>
            비밀번호 변경
          </button>
        </div>
      </form>
    </Dialog>
  );
}
