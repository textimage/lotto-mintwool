import {
  useEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type FormEvent,
} from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import {
  ArrowUpRight,
  Plus,
  Heart,
  Ticket,
  QrCode,
  Pencil,
  Trash2,
  Copy,
  Download,
  Coins,
  Target,
  ArrowRight,
  Camera,
  ImagePlus,
  LoaderCircle,
  ChevronDown,
  X,
} from "lucide-react";
import type { IScannerControls } from "@zxing/browser";
import {
  parseNumbers,
  parsePurchasePaste,
  drawDateFor,
  nextPurchaseRound,
  roundForDate,
  favoriteLabel,
  numberCombinationKey,
  type GroupedPurchases,
  type Favorite,
  type Draw,
  type TicketView,
  type PurchaseGame,
  type EnsureFavoriteResponse,
} from "../../shared/domain";
import {
  api,
  dateLabel,
  money,
  useApi,
  useApp,
  useAction,
  useMediaQuery,
  download,
  syncPollingInterval,
  type Meta,
} from "../lib";
import {
  PageTitle,
  Numbers,
  Empty,
  Loading,
  ErrorBox,
  Dialog,
  NumberInput,
  TicketCard,
  Pagination,
} from "../components";

import { HistoryDialog } from "../history";

interface DashboardData {
  month: string;
  latest: Draw | null;
  nextRound: number;
  nextDate: string;
  confirmedPrize: number;
  totalGames: number;
  unsettledGames: number;
  wonGames: number;
  settledGames: number;
  recent: TicketView[];
  favoriteCount: number;
  coverage: Meta["coverage"];
  latestJob: Meta["latestJob"];
}
export function Dashboard() {
  const [month, setMonth] = useState(
    new Date().toLocaleDateString("en-CA", {
      timeZone: "Asia/Seoul",
      year: "numeric",
      month: "2-digit",
    }),
  );
  const { data, loading, error } = useApi<DashboardData>(
    "/dashboard?month=" + month,
    syncPollingInterval,
  );
  return (
    <>
      <PageTitle eyebrow="LOTTO 6/45" title="로또 6/45">
        <Link to="/purchases" state={{ qr: true }} className="button subtle">
          <QrCode size={17} />
          QR 등록
        </Link>
        <Link to="/purchases" state={{ add: true }} className="button primary">
          <Plus size={18} />
          수동 등록
        </Link>
      </PageTitle>
      {error && <ErrorBox error={error} />}
      {!data && loading ? (
        <Loading />
      ) : (
        data && (
          <>
            <section className="card latest-card">
              <div className="section-top">
                <div className="inline">
                  <span className="live-dot" />
                  최근 추첨 결과
                </div>
                {data.latest && (
                  <Link className="text-link" to="/draws">
                    전체 회차 <ArrowUpRight size={15} />
                  </Link>
                )}
              </div>
              {data.latest ? (
                <div className="latest-body">
                  <div className="latest-draw">
                    <div className="draw-heading">
                      <div>
                        <span className="draw-round">
                          제 {data.latest.drawNo}회
                        </span>
                        <span className="muted">
                          {dateLabel(data.latest.drawDate)} 추첨
                        </span>
                      </div>
                      <span className="badge neutral">
                        {data.latest.status === "complete"
                          ? "집계 완료"
                          : "당첨금 집계 중"}
                      </span>
                    </div>
                    <Numbers
                      numbers={data.latest.numbers}
                      bonus={data.latest.bonusNumber}
                    />
                  </div>
                  <div className="latest-prize">
                    <div>
                      <span className="muted">1등 게임당 당첨금</span>
                      <strong>
                        {data.latest.status !== "complete"
                          ? "집계 중"
                          : data.latest.ranks[0].numWinners === 0
                            ? "당첨자 없음"
                            : money(data.latest.ranks[0].prizePerGame)}
                      </strong>
                    </div>
                    <div>
                      <span className="muted">1등 당첨 게임</span>
                      <strong>
                        {data.latest.ranks[0].numWinners ?? "—"}
                        <small>게임</small>
                      </strong>
                    </div>
                  </div>
                </div>
              ) : (
                <Empty
                  title="첫 회차를 가져오는 중이에요"
                  text="설정에서 수집 진행 상황을 확인할 수 있습니다."
                >
                  <Link className="button subtle" to="/settings">
                    데이터 수집 확인 <ArrowRight size={16} />
                  </Link>
                </Empty>
              )}
            </section>
            <div className="section-heading month-heading">
              <div>
                <h2>이번 달의 기록</h2>
                <p>추첨일 기준 · 당첨금은 세전 금액입니다.</p>
              </div>
              <label className="month-control">
                <span className="sr-only">집계 월</span>
                <input
                  type="month"
                  value={month}
                  onChange={(e) => {
                    if (e.target.value) setMonth(e.target.value);
                  }}
                />
              </label>
            </div>
            <div className="summary-grid">
              <Summary
                label="구매번호수"
                value={`${data.totalGames.toLocaleString()}개`}
                sub="번호 6개 조합을 1개로 계산"
                icon={<Ticket size={20} />}
              />
              <Summary
                label="확정 당첨금"
                value={money(data.confirmedPrize)}
                sub={`당첨 ${data.wonGames}개 · 미확정 ${data.unsettledGames}개`}
                icon={<Coins size={20} />}
                accent
              />
              <Summary
                label="당첨번호수"
                value={`${data.wonGames.toLocaleString()}개`}
                sub="당첨이 확정된 구매번호수"
                icon={<Heart size={20} />}
              />
              <Summary
                label="당첨 비율"
                value={
                  data.settledGames
                    ? ((data.wonGames / data.settledGames) * 100).toFixed(1) +
                      "%"
                    : "—"
                }
                sub={`결과 확정 ${data.settledGames}개 기준`}
                icon={<Target size={20} />}
              />
            </div>
          </>
        )
      )}
    </>
  );
}
function Summary({
  label,
  value,
  sub,
  icon,
  accent = false,
}: {
  label: string;
  value: string;
  sub: string;
  icon: React.ReactNode;
  accent?: boolean;
}) {
  return (
    <div className={"card summary-card" + (accent ? " accent" : "")}>
      <div className="summary-label">
        {label}
        <span>{icon}</span>
      </div>
      <strong>{value}</strong>
      <p>{sub}</p>
    </div>
  );
}

export function Favorites() {
  const { data, loading, error } = useApi<{ favorites: Favorite[] }>(
    "/favorites",
  );
  const [edit, setEdit] = useState<Favorite | "new" | null>(null);
  const [history, setHistory] = useState<Favorite | null>(null);
  const { refresh, toast } = useApp();
  const action = useAction();
  return (
    <>
      <PageTitle
        eyebrow="MY NUMBERS"
        title="나의 번호"
        description="마음에 드는 조합을 보관하고, 필요할 때 구매 기록에 담으세요."
      >
        <button className="button primary" onClick={() => setEdit("new")}>
          <Plus size={18} />
          번호 추가
        </button>
      </PageTitle>
      {error && <ErrorBox error={error} />}
      {loading && !data ? (
        <Loading />
      ) : (
        data &&
        (data.favorites.length ? (
          <div className="favorite-list">
            {data.favorites.map((favorite) => (
              <article className="card favorite-card" key={favorite.id}>
                <Numbers numbers={favorite.numbers} small />
                {favorite.name && (
                  <div className="favorite-heading">
                    <h2 title={favorite.name}>{favorite.name}</h2>
                  </div>
                )}
                {favorite.memo && (
                  <p className="favorite-memo">{favorite.memo}</p>
                )}
                <div className="favorite-actions">
                  <button
                    className="button subtle"
                    aria-label={favoriteLabel(favorite) + " 당첨이력"}
                    onClick={(event) => {
                      event.currentTarget.focus({ preventScroll: true });
                      setHistory(favorite);
                    }}
                  >
                    <Target size={16} />
                    당첨이력
                  </button>
                  <button
                    className="button primary-soft"
                    disabled={action.busy}
                    aria-label={favoriteLabel(favorite) + " 구매에 담기"}
                    onClick={(event) => {
                      if (event.detail > 1) return;
                      void action.run(async () => {
                        const ticket = await api<TicketView>(
                          "/favorites/" + favorite.id + "/purchase",
                          "POST",
                          {},
                        );
                        refresh();
                        toast(`제 ${ticket.drawNo}회에 1장을 담았습니다.`);
                      });
                    }}
                  >
                    <Copy size={16} />
                    구매에 담기
                  </button>
                  <button
                    className="icon-button"
                    aria-label={favoriteLabel(favorite) + " 수정"}
                    onClick={() => setEdit(favorite)}
                  >
                    <Pencil size={17} />
                  </button>
                  <button
                    className="icon-button danger"
                    disabled={action.busy}
                    aria-label={favoriteLabel(favorite) + " 삭제"}
                    onClick={() => {
                      if (
                        confirm(
                          "이 고정 조합을 삭제할까요? 기존 구매 기록은 유지됩니다.",
                        )
                      )
                        void action.run(async () => {
                          await api("/favorites/" + favorite.id, "DELETE");
                          refresh();
                          toast("조합을 삭제했습니다.");
                        });
                    }}
                  >
                    <Trash2 size={17} />
                  </button>
                </div>
              </article>
            ))}
          </div>
        ) : (
          <section className="card">
            <Empty
              title="아직 보관한 조합이 없어요"
              text="번호만 입력해도 저장할 수 있어요. 이름과 메모는 선택입니다."
            >
              <button className="button primary" onClick={() => setEdit("new")}>
                <Plus size={17} />
                번호 추가
              </button>
            </Empty>
          </section>
        ))
      )}
      {edit && (
        <FavoriteForm
          favorite={edit === "new" ? undefined : edit}
          close={() => setEdit(null)}
        />
      )}
      {history && (
        <HistoryDialog
          key={history.id}
          numbers={history.numbers}
          description={favoriteLabel(history)}
          close={() => setHistory(null)}
        />
      )}
    </>
  );
}
export function FavoriteForm({
  favorite,
  numbers,
  close,
}: {
  favorite?: Favorite;
  numbers?: number[];
  close: () => void;
}) {
  const [name, setName] = useState(favorite?.name ?? "");
  const [chosen, setChosen] = useState(
    (favorite?.numbers ?? numbers ?? []).join(", "),
  );
  const [memo, setMemo] = useState(favorite?.memo ?? "");
  const { refresh, toast } = useApp();
  const action = useAction();
  function submit(e: FormEvent) {
    e.preventDefault();
    void action.run(async () => {
      await api(
        "/favorites" + (favorite ? "/" + favorite.id : ""),
        favorite ? "PUT" : "POST",
        { name, numbers: parseNumbers(chosen), memo },
      );
      refresh();
      toast("나의 번호에 저장했습니다.");
      close();
    });
  }
  return (
    <Dialog
      title={favorite ? "번호 수정" : "번호 추가"}
      description="회차 없이 보관하는 고정 번호입니다."
      close={close}
    >
      <form onSubmit={submit} className="form-stack">
        <NumberInput value={chosen} onChange={setChosen} />
        <label>
          조합 이름 <span className="field-hint">선택</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={80}
            placeholder="예: 매주 함께하는 번호"
          />
        </label>
        <label>
          메모 <span className="field-hint">선택</span>
          <textarea
            value={memo}
            onChange={(e) => setMemo(e.target.value)}
            rows={3}
            maxLength={2000}
            placeholder="이 조합을 고른 이유를 적어보세요."
          />
        </label>
        {action.error && <ErrorBox error={action.error} />}
        <div className="form-footer">
          <button className="button subtle" type="button" onClick={close}>
            취소
          </button>
          <button className="button primary" disabled={action.busy}>
            {action.busy && <LoaderCircle className="spin" size={16} />}조합
            저장
          </button>
        </div>
      </form>
    </Dialog>
  );
}

export function Purchases() {
  const location = useLocation();
  const isMobile = useMediaQuery("(max-width: 760px)");
  const [page, setPage] = useState(1);
  const [month, setMonth] = useState("");
  const [round, setRound] = useState(() => {
    const value = new URLSearchParams(location.search).get("drawNo") ?? "";
    return /^[1-9]\d{0,3}$/.test(value) || value === "10000" ? value : "";
  });
  const [status, setStatus] = useState("");
  const [expanded, setExpanded] = useState<Record<number, boolean>>({});
  useEffect(() => {
    if (isMobile) {
      setMonth("");
      setPage(1);
    }
  }, [isMobile]);
  useEffect(() => setExpanded({}), [month, round, status]);
  const query = new URLSearchParams({
    page: String(page),
    groupBy: "draw",
    ...(!isMobile && month ? { month } : {}),
    ...(round ? { drawNo: round } : {}),
    ...(status ? { status } : {}),
  });
  const { data, error, loading } = useApi<GroupedPurchases>(
    "/purchases?" + query.toString(),
  );
  const [form, setForm] = useState<{
    ticket?: TicketView;
    favorite?: Favorite;
  } | null>(null);
  const [qr, setQr] = useState(false);
  const [history, setHistory] = useState<{
    numbers: number[];
    description: string;
  } | null>(null);
  const action = useAction();
  const saveAction = useAction();
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [saved, setSaved] = useState<Record<string, number>>({});
  const favorites = useApi<{ favorites: Favorite[] }>("/favorites");
  const { revision, refresh, toast } = useApp();
  const revisionRef = useRef(revision);
  revisionRef.current = revision;
  const savedKeys = new Set(
    favorites.data?.favorites.map((favorite) =>
      numberCombinationKey(favorite.numbers),
    ),
  );
  // Keep successful writes visible until a subsequent favorites read completes.
  for (const [key, savedRevision] of Object.entries(saved)) {
    if (
      favorites.dataRevision === null ||
      favorites.dataRevision < savedRevision
    )
      savedKeys.add(key);
  }
  function saveNumbers(numbers: number[]) {
    const key = numberCombinationKey(numbers);
    void saveAction.run(async () => {
      setSavingKey(key);
      try {
        const result = await api<EnsureFavoriteResponse>(
          "/favorites/ensure",
          "POST",
          { numbers: [...numbers] },
        );
        setSaved((current) => ({
          ...current,
          [numberCombinationKey(result.favorite.numbers)]:
            revisionRef.current + 1,
        }));
        refresh();
        toast(
          result.created
            ? "나의 번호에 저장했습니다."
            : "이미 나의 번호에 저장된 조합입니다.",
        );
      } finally {
        setSavingKey(null);
      }
    });
  }
  const navigate = useNavigate();
  useEffect(() => {
    const state = location.state as {
      favorite?: Favorite;
      add?: boolean;
      qr?: boolean;
    } | null;
    if (state?.favorite || state?.add || state?.qr) {
      if (state.qr) setQr(true);
      else setForm({ favorite: state.favorite });
      navigate("/purchases", { replace: true, state: null });
    }
  }, [location.state, navigate]);
  return (
    <>
      <PageTitle
        eyebrow="PURCHASE LOG"
        title="구입한 번호"
        description="회차별 구매번호수와 당첨 결과를 확인하세요."
      >
        <button
          className="button subtle"
          disabled={action.busy}
          onClick={() => void action.run(() => download("/purchases.csv"))}
        >
          <Download size={17} />
          CSV
        </button>
        <button className="button subtle" onClick={() => setQr(true)}>
          <QrCode size={18} />
          QR 등록
        </button>
        <button className="button primary" onClick={() => setForm({})}>
          <Plus size={18} />
          수동 등록
        </button>
      </PageTitle>
      <div className="card filter-bar purchase-filters">
        {!isMobile && (
          <label>
            추첨 월
            <input
              type="month"
              value={month}
              onChange={(e) => {
                setMonth(e.target.value);
                setPage(1);
              }}
            />
          </label>
        )}
        <label>
          회차
          <input
            type="number"
            min="1"
            max="10000"
            value={round}
            onChange={(e) => {
              setRound(e.target.value);
              setPage(1);
            }}
            placeholder="전체 회차"
          />
        </label>
        <label>
          결과
          <select
            value={status}
            onChange={(e) => {
              setStatus(e.target.value);
              setPage(1);
            }}
          >
            <option value="">전체 결과</option>
            <option value="won">당첨</option>
            <option value="lost">낙첨</option>
            <option value="pending">추첨 대기</option>
            <option value="missing">결과 미수집</option>
            <option value="tallying">집계 중</option>
            <option value="unpriced">배당 산정 불가</option>
          </select>
        </label>
        <div className="purchase-filter-footer">
          <button
            className="button subtle filter-reset"
            onClick={() => {
              setMonth("");
              setRound("");
              setStatus("");
              setPage(1);
            }}
          >
            초기화
          </button>
          {data && (
            <span className="filter-count">
              총 <strong>{data.total.toLocaleString()}</strong>회차 · 구매번호수{" "}
              <strong>{data.totalGames.toLocaleString()}</strong>개
            </span>
          )}
        </div>
      </div>
      {error && <ErrorBox error={error} />}
      {favorites.error && (
        <div className="purchase-favorites-error">
          <ErrorBox
            error={`저장 여부를 확인하지 못했습니다. ${favorites.error}`}
          />
          <button className="button subtle" onClick={refresh}>
            다시 확인
          </button>
        </div>
      )}
      {saveAction.error && <ErrorBox error={saveAction.error} />}
      {!data && loading ? (
        <Loading />
      ) : (
        data &&
        (data.groups.length ? (
          <div className="ticket-list">
            {data.groups.map((group) => {
              const open =
                expanded[group.drawNo] ??
                data.latestRounds.includes(group.drawNo);
              const id = `purchase-round-${group.drawNo}`;
              return (
                <section
                  className="card purchase-round-group"
                  key={group.drawNo}
                  aria-label={`제 ${group.drawNo}회 구매 기록`}
                >
                  <button
                    className="purchase-round-heading"
                    aria-expanded={open}
                    aria-controls={id}
                    onClick={() =>
                      setExpanded((current) => ({
                        ...current,
                        [group.drawNo]: !open,
                      }))
                    }
                  >
                    <span className="purchase-round-label">
                      제 {group.drawNo}회
                    </span>
                    <span className="muted">{dateLabel(group.drawDate)}</span>
                    <span className="purchase-round-count">
                      구매번호수{" "}
                      <strong>{group.totalGames.toLocaleString()}개</strong>
                    </span>
                    <ChevronDown
                      size={18}
                      className={open ? "" : "collapsed"}
                    />
                  </button>
                  <div
                    id={id}
                    className="purchase-round-tickets"
                    hidden={!open}
                  >
                    {open &&
                      group.tickets.map((ticket) => (
                        <TicketCard
                          key={ticket.id}
                          ticket={ticket}
                          showRound={false}
                          renderGameActions={(game, index) => {
                            const key = numberCombinationKey(game.numbers);
                            const label =
                              index < 26
                                ? String.fromCharCode(65 + index)
                                : String(index + 1);
                            const description = `제${ticket.drawNo}회 · ${label} 조합`;
                            const isSaved = savedKeys.has(key);
                            const saving = savingKey === key;
                            return (
                              <>
                                <button
                                  className="button subtle"
                                  aria-label={`${description} 과거 당첨 조회`}
                                  onClick={(event) => {
                                    event.currentTarget.focus({
                                      preventScroll: true,
                                    });
                                    setHistory({
                                      numbers: [...game.numbers],
                                      description,
                                    });
                                  }}
                                >
                                  <Target size={16} />
                                  과거 당첨 조회
                                </button>
                                <button
                                  className={
                                    "button " +
                                    (isSaved ? "primary-soft" : "subtle")
                                  }
                                  disabled={saveAction.busy || isSaved}
                                  aria-label={`${description} ${isSaved ? "나의 번호에 저장됨" : "나의 번호에 저장"}`}
                                  onClick={() => saveNumbers(game.numbers)}
                                >
                                  {saving ? (
                                    <LoaderCircle className="spin" size={16} />
                                  ) : (
                                    <Heart
                                      size={16}
                                      fill={isSaved ? "currentColor" : "none"}
                                    />
                                  )}
                                  {saving
                                    ? "저장 중"
                                    : isSaved
                                      ? "저장됨"
                                      : "나의 번호에 저장"}
                                </button>
                              </>
                            );
                          }}
                          actions={
                            <div className="inline">
                              <button
                                className="icon-button"
                                aria-label={ticket.drawNo + "회 구매 수정"}
                                onClick={() => setForm({ ticket })}
                              >
                                <Pencil size={16} />
                              </button>
                              <button
                                className="icon-button danger"
                                aria-label={ticket.drawNo + "회 구매 삭제"}
                                disabled={action.busy}
                                onClick={() => {
                                  if (confirm("이 구매 기록을 삭제할까요?"))
                                    void action.run(async () => {
                                      await api(
                                        "/purchases/" + ticket.id,
                                        "DELETE",
                                      );
                                      if (
                                        page > 1 &&
                                        data.groups.length === 1 &&
                                        group.tickets.length === 1
                                      )
                                        setPage(page - 1);
                                      refresh();
                                      toast("구매 기록을 삭제했습니다.");
                                    });
                                }}
                              >
                                <Trash2 size={16} />
                              </button>
                            </div>
                          }
                        />
                      ))}
                  </div>
                </section>
              );
            })}
            <Pagination {...data} unit="회차" onChange={setPage} />
          </div>
        ) : (
          <section className="card">
            <Empty
              title="표시할 구매 기록이 없어요"
              text="수동 등록 또는 복권 QR 등록을 이용해 주세요."
            >
              <button className="button primary" onClick={() => setForm({})}>
                <Plus size={17} />
                수동 등록
              </button>
            </Empty>
          </section>
        ))
      )}
      {form && <PurchaseForm {...form} close={() => setForm(null)} />}
      {qr && <QrForm close={() => setQr(false)} />}
      {history && (
        <HistoryDialog
          numbers={history.numbers}
          description={history.description}
          close={() => setHistory(null)}
        />
      )}
    </>
  );
}

function PurchaseForm({
  ticket,
  favorite,
  close,
}: {
  ticket?: TicketView;
  favorite?: Favorite;
  close: () => void;
}) {
  const initialRound = ticket?.drawNo ?? nextPurchaseRound();
  const [round, setRound] = useState(String(initialRound));
  const [date, setDate] = useState(
    ticket?.drawDate ?? drawDateFor(initialRound),
  );
  const [dateError, setDateError] = useState("");
  const [pasteError, setPasteError] = useState("");
  const [lines, setLines] = useState(
    ticket?.games.map((g) => g.numbers.join(", ")).join("\n") ??
      favorite?.numbers.join(", ") ??
      "",
  );
  const [quantities, setQuantities] = useState<number[]>(
    ticket?.games.map((g) => g.quantity) ?? [1],
  );
  const [memo, setMemo] = useState(
    ticket?.memo ?? (favorite ? favorite.name : ""),
  );
  const { refresh, toast } = useApp();
  const action = useAction();
  const rows = lines.split("\n").filter((line) => line.trim());
  const totalGames = rows.reduce((sum, _, i) => sum + (quantities[i] ?? 1), 0);
  function roundChange(value: string) {
    setPasteError("");
    setRound(value);
    try {
      setDate(drawDateFor(Number(value)));
      setDateError("");
    } catch {
      setDateError("올바른 회차를 입력해 주세요.");
    }
  }
  function dateChange(value: string) {
    setPasteError("");
    setDate(value);
    try {
      setRound(String(roundForDate(value)));
      setDateError("");
    } catch (error) {
      setDateError((error as Error).message);
    }
  }
  function pastePurchase(event: ClipboardEvent<HTMLTextAreaElement>) {
    if (ticket?.source === "qr") return;
    try {
      const purchase = parsePurchasePaste(
        event.clipboardData.getData("text/plain"),
      );
      setPasteError("");
      if (!purchase) return;
      event.preventDefault();
      setLines(purchase.games.map((numbers) => numbers.join(" ")).join("\n"));
      setQuantities(purchase.games.map(() => 1));
      if (purchase.drawNo !== undefined && purchase.drawDate !== undefined) {
        setRound(String(purchase.drawNo));
        setDate(purchase.drawDate);
        setDateError("");
      }
    } catch (error) {
      event.preventDefault();
      setPasteError((error as Error).message);
    }
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    void action.run(async () => {
      if (dateError) throw new Error(dateError);
      if (pasteError) throw new Error(pasteError);
      const games = rows.map((line, i) => ({
        numbers: parseNumbers(line),
        quantity: quantities[i] ?? 1,
      }));
      if (!games.length) throw new Error("한 게임 이상 입력해 주세요.");
      const body =
        ticket?.source === "qr"
          ? { memo }
          : {
              drawNo: Number(round),
              drawDate: date,
              memo,
              games,
              source: favorite ? "favorite" : (ticket?.source ?? "manual"),
              favoriteId: favorite?.id ?? ticket?.favoriteId ?? null,
            };
      await api(
        "/purchases" + (ticket ? "/" + ticket.id : ""),
        ticket ? "PUT" : "POST",
        body,
      );
      refresh();
      toast("구매 기록을 저장했습니다.");
      close();
    });
  }
  return (
    <Dialog
      title={ticket ? "구매 기록 수정" : "수동 등록"}
      description="회차와 추첨일은 함께 연결됩니다. 미래 회차도 기록할 수 있어요."
      close={close}
    >
      <form className="form-stack" onSubmit={submit}>
        <div className="form-row">
          <label>
            회차
            <input
              type="number"
              min={1}
              max={10000}
              required
              value={round}
              onChange={(e) => roundChange(e.target.value)}
              disabled={ticket?.source === "qr"}
            />
          </label>
          <label>
            추첨일
            <input
              type="date"
              required
              value={date}
              onChange={(e) => dateChange(e.target.value)}
              disabled={ticket?.source === "qr"}
            />
          </label>
        </div>
        {dateError && <ErrorBox error={dateError} />}
        <label>
          구매 번호{" "}
          <span className="field-hint">한 줄에 6개 · 여러 조합 입력 가능</span>
          <textarea
            className="numbers-textarea"
            required
            rows={Math.min(6, Math.max(3, rows.length))}
            value={lines}
            onChange={(e) => {
              setLines(e.target.value);
              setPasteError("");
            }}
            onPaste={pastePurchase}
            placeholder={"4, 5, 25, 28, 32, 42\n6 12 18 24 30 36"}
            disabled={ticket?.source === "qr"}
          />
        </label>
        {ticket?.source !== "qr" && (
          <p className="field-hint">
            동행복권 전체 내용을 붙여넣으면 회차와 번호를 자동 입력합니다.
          </p>
        )}
        {pasteError && <ErrorBox error={pasteError} />}
        {rows.length > 0 && (
          <div className="game-previews">
            {rows.map((line, i) => {
              let chosen: number[] = [];
              try {
                chosen = parseNumbers(line);
              } catch {
                /* Show inline validation while typing. */
              }
              return (
                <div className="game-preview" key={i}>
                  <span className="game-index">
                    {String.fromCharCode(65 + i)}
                  </span>
                  {chosen.length ? (
                    <Numbers numbers={chosen} small />
                  ) : (
                    <span className="muted">번호 6개를 확인해 주세요.</span>
                  )}
                  <label className="quantity-field">
                    <span>수량</span>
                    <input
                      type="number"
                      min={1}
                      max={1000}
                      aria-label={`${i + 1}번째 게임 수량`}
                      value={quantities[i] ?? 1}
                      disabled={ticket?.source === "qr"}
                      onChange={(e) =>
                        setQuantities((q) => {
                          const copy = [...q];
                          copy[i] = Number(e.target.value);
                          return copy;
                        })
                      }
                    />
                  </label>
                </div>
              );
            })}
          </div>
        )}
        <p className="field-hint">
          구매번호수 <strong>{totalGames.toLocaleString()}개</strong> · 번호 6개
          조합을 1개로 계산
        </p>
        <label>
          메모 <span className="field-hint">선택</span>
          <input
            maxLength={2000}
            value={memo}
            onChange={(e) => setMemo(e.target.value)}
            placeholder="구매처나 기억할 내용을 남기세요."
          />
        </label>
        {action.error && <ErrorBox error={action.error} />}
        <div className="form-footer">
          <button type="button" className="button subtle" onClick={close}>
            취소
          </button>
          <button className="button primary" disabled={action.busy}>
            {action.busy && <LoaderCircle className="spin" size={16} />}구매
            기록 저장
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function QrForm({ close }: { close: () => void }) {
  const [raw, setRaw] = useState("");
  const [preview, setPreview] = useState<{
    drawNo: number;
    drawDate: string;
    games: PurchaseGame[];
  } | null>(null);
  const [camera, setCamera] = useState(false);
  const video = useRef<HTMLVideoElement>(null);
  const controls = useRef<IScannerControls | null>(null);
  const [cameraError, setCameraError] = useState("");
  const [decoding, setDecoding] = useState(false);
  const action = useAction();
  const { refresh, toast } = useApp();
  async function decode(value: string) {
    const data = await api<{
      drawNo: number;
      drawDate: string;
      games: PurchaseGame[];
    }>("/qr/parse", "POST", { raw: value });
    setRaw(value);
    setPreview(data);
  }
  useEffect(() => {
    if (!camera || !video.current) return;
    let disposed = false;
    setCameraError("");
    const begin = async () => {
      const { BrowserQRCodeReader } = await import("@zxing/browser");
      if (disposed || !video.current) return;
      const scanner = await new BrowserQRCodeReader().decodeFromVideoDevice(
        undefined,
        video.current,
        (result, _error, scanner) => {
          if (result && !disposed) {
            scanner.stop();
            setCamera(false);
            void decode(result.getText()).catch((error) =>
              setCameraError(error.message),
            );
          }
        },
      );
      if (disposed) scanner.stop();
      else controls.current = scanner;
    };
    void begin().catch((error) => {
      if (!disposed) {
        setCamera(false);
        setCameraError(
          error.name === "NotAllowedError"
            ? "카메라 사용이 허용되지 않았습니다. 사진을 선택하거나 QR 주소를 붙여넣어 주세요."
            : "카메라를 시작할 수 없습니다. HTTPS 접속과 카메라 장치를 확인해 주세요.",
        );
      }
    });
    return () => {
      disposed = true;
      controls.current?.stop();
      controls.current = null;
    };
  }, [camera]);
  async function fileSelected(file?: File) {
    if (!file) return;
    setCamera(false);
    setCameraError("");
    action.clearError();
    setPreview(null);
    if (
      !["image/jpeg", "image/png", "image/webp"].includes(file.type) ||
      file.size > 15 * 1024 * 1024
    ) {
      setCameraError("15MB 이하의 JPG, PNG, WebP 사진을 선택해 주세요.");
      return;
    }
    setDecoding(true);
    const url = URL.createObjectURL(file);
    let qrFound = false;
    try {
      const { BrowserQRCodeReader } = await import("@zxing/browser");
      const result = await new BrowserQRCodeReader().decodeFromImageUrl(url);
      qrFound = true;
      await decode(result.getText());
    } catch (error) {
      setCameraError(
        qrFound && error instanceof Error
          ? error.message
          : "사진에서 로또 QR을 찾지 못했습니다. QR이 크게 보이는 사진을 선택해 주세요.",
      );
    } finally {
      setDecoding(false);
      URL.revokeObjectURL(url);
    }
  }
  return (
    <Dialog
      title="복권 QR 등록"
      description="QR 한 번으로 최대 5게임을 한꺼번에 등록하세요."
      close={close}
    >
      <div className="form-stack">
        <div className="qr-options">
          <button
            className="button primary-soft"
            onClick={() => {
              setPreview(null);
              action.clearError();
              setCamera(true);
            }}
          >
            <Camera size={20} />
            카메라로 읽기
          </button>
          <label className="button subtle file-button">
            <ImagePlus size={20} />
            {decoding ? "사진 읽는 중…" : "사진 선택"}
            <input
              type="file"
              accept="image/jpeg,image/png,image/webp"
              disabled={decoding}
              onChange={(e) => {
                const selected = e.target.files?.[0];
                e.target.value = "";
                void fileSelected(selected);
              }}
            />
          </label>
        </div>
        {camera && (
          <div className="camera-box">
            <video ref={video} playsInline muted />
            <button
              className="icon-button"
              aria-label="카메라 닫기"
              onClick={() => setCamera(false)}
            >
              <X size={20} />
            </button>
            <p>복권의 QR 코드를 화면 중앙에 맞춰주세요.</p>
          </div>
        )}
        {cameraError && <ErrorBox error={cameraError} />}
        {action.error && <ErrorBox error={action.error} />}
        <label>
          QR 주소 붙여넣기
          <textarea
            rows={3}
            value={raw}
            onChange={(e) => {
              setRaw(e.target.value);
              setPreview(null);
            }}
            placeholder="동행복권 QR URL 또는 QR 원본 내용"
          />
        </label>
        <button
          className="button subtle"
          disabled={!raw.trim() || action.busy}
          onClick={() => void action.run(() => decode(raw))}
        >
          <QrCode size={17} />
          번호 확인
        </button>
        {preview && (
          <div className="qr-preview">
            <h3>
              제 {preview.drawNo}회{" "}
              <span className="muted">{dateLabel(preview.drawDate)}</span>
            </h3>
            {preview.games.map((game, i) => (
              <div className="game-preview" key={i}>
                <span className="game-index">
                  {String.fromCharCode(65 + i)}
                </span>
                <Numbers numbers={game.numbers} small />
              </div>
            ))}
            <div className="inline spread">
              <span>구매번호수</span>
              <strong>
                {preview.games.reduce((sum, game) => sum + game.quantity, 0)}개
              </strong>
            </div>
            <button
              className="button primary full"
              disabled={action.busy}
              onClick={() =>
                void action.run(async () => {
                  await api("/purchases", "POST", {
                    drawNo: preview.drawNo,
                    drawDate: preview.drawDate,
                    games: preview.games,
                    source: "qr",
                    qrRaw: raw,
                  });
                  refresh();
                  toast(`구매번호 ${preview.games.length}개를 등록했습니다.`);
                  close();
                })
              }
            >
              {action.busy && <LoaderCircle className="spin" size={16} />}이
              번호를 구매 기록에 등록
            </button>
          </div>
        )}
        <p className="field-hint">
          사진은 이 브라우저에서만 해독합니다. 같은 복권 QR은 한 번만
          등록됩니다.
        </p>
      </div>
    </Dialog>
  );
}
