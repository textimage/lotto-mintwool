import { useEffect, useState } from "react";
import { ChevronRight, LoaderCircle } from "lucide-react";
import type { Draw, Favorite, GameResult } from "../shared/domain";
import { parseNumbers, favoriteLabel } from "../shared/domain";
import { api, dateLabel, money, useApi, useApp } from "./lib";
import {
  Badge,
  Dialog,
  Empty,
  ErrorBox,
  NumberInput,
  Numbers,
  Pagination,
} from "./components";

interface HistoryData {
  numbers: number[];
  compared: number;
  hits: number;
  bestRank: number | null;
  counts: { rank: number; count: number }[];
  rows: { draw: Draw; result: GameResult }[];
  total: number;
  page: number;
  pageSize: number;
}

function FavoritePicker({
  value,
  onSelect,
}: {
  value: string;
  onSelect: (favorite: Favorite | null) => void;
}) {
  const { data, error } = useApi<{ favorites: Favorite[] }>("/favorites");
  return (
    <div className="history-favorite-picker">
      <label>
        나의 번호에서 선택
        <select
          value={value}
          onChange={(event) => {
            const favorite = data?.favorites.find(
              (item) => item.id === event.target.value,
            );
            onSelect(favorite ?? null);
          }}
        >
          <option value="">직접 입력하기</option>
          {data?.favorites.map((favorite) => (
            <option key={favorite.id} value={favorite.id}>
              {favoriteLabel(favorite)}
            </option>
          ))}
        </select>
      </label>
      {error && <ErrorBox error={error} />}
    </div>
  );
}

export function HistoryLookup({
  initialNumbers,
  fixed = false,
}: {
  initialNumbers?: number[];
  fixed?: boolean;
}) {
  const [numbers, setNumbers] = useState(initialNumbers?.join(" ") ?? "");
  const [selectedFavorite, setSelectedFavorite] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [rank, setRank] = useState("");
  const [pagination, setPagination] = useState({ key: "", page: 1 });
  const [retry, setRetry] = useState(0);
  const [outcome, setOutcome] = useState<{
    key: string;
    data?: HistoryData;
    error?: string;
  } | null>(null);
  const { revision } = useApp();
  function editValue(setValue: (value: string) => void, value: string) {
    setValue(value);
    setPagination({ key: "", page: 1 });
  }
  let parsed: number[] | null = null;
  let validationError = "";
  if (numbers.trim()) {
    try {
      parsed = parseNumbers(numbers);
    } catch (error) {
      validationError = (error as Error).message;
    }
  }
  if (parsed) {
    if (
      [from, to].some(
        (value) =>
          value && (!Number.isInteger(Number(value)) || Number(value) < 1),
      )
    )
      validationError = "회차는 1 이상의 정수로 입력해 주세요.";
    else if (
      (from && to && Number(from) > Number(to)) ||
      (dateFrom && dateTo && dateFrom > dateTo)
    )
      validationError = "조회 시작 범위가 종료 범위보다 클 수 없습니다.";
  }
  const filters =
    parsed && !validationError
      ? {
          numbers: parsed,
          ...(from ? { from: Number(from) } : {}),
          ...(to ? { to: Number(to) } : {}),
          ...(dateFrom ? { dateFrom } : {}),
          ...(dateTo ? { dateTo } : {}),
          ...(rank ? { rank: Number(rank) } : {}),
        }
      : null;
  const filterKey = filters ? JSON.stringify(filters) : "";
  const page = pagination.key === filterKey ? pagination.page : 1;
  const requestKey = filters ? JSON.stringify({ ...filters, page }) : "";
  const currentOutcome = outcome?.key === requestKey ? outcome : null;
  const data = currentOutcome?.data;
  const error = currentOutcome?.error;
  const loading = Boolean(requestKey && !currentOutcome);

  useEffect(() => {
    if (!requestKey) return;
    let cancelled = false;
    const controller = new AbortController();
    setOutcome(null);
    const timer = setTimeout(async () => {
      try {
        const data = await api<HistoryData>(
          "/history",
          "POST",
          JSON.parse(requestKey),
          { signal: controller.signal },
        );
        if (!cancelled) setOutcome({ key: requestKey, data });
      } catch (error) {
        if (!cancelled)
          setOutcome({
            key: requestKey,
            error:
              error instanceof Error
                ? error.message
                : "과거 결과를 불러오지 못했습니다.",
          });
      }
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      controller.abort();
    };
  }, [requestKey, revision, retry]);

  return (
    <div className="history-lookup">
      <section className="card history-form">
        {fixed ? (
          <div className="history-fixed-numbers">
            <span className="muted">조회할 번호</span>
            <Numbers numbers={parsed ?? initialNumbers ?? []} />
          </div>
        ) : (
          <div className="history-entry">
            <FavoritePicker
              value={selectedFavorite}
              onSelect={(favorite) => {
                setSelectedFavorite(favorite?.id ?? "");
                editValue(setNumbers, favorite?.numbers.join(" ") ?? "");
              }}
            />
            <NumberInput
              showHint={false}
              value={numbers}
              onChange={(value) => {
                setSelectedFavorite("");
                editValue(setNumbers, value);
              }}
            />
          </div>
        )}
        <details className="history-filters">
          <summary>
            조회 범위와 등수 설정 <ChevronRight size={16} />
          </summary>
          <div className="filter-fields">
            <label>
              시작 회차
              <input
                type="number"
                min={1}
                value={from}
                onChange={(e) => editValue(setFrom, e.target.value)}
                placeholder="1회부터"
              />
            </label>
            <label>
              종료 회차
              <input
                type="number"
                min={1}
                value={to}
                onChange={(e) => editValue(setTo, e.target.value)}
                placeholder="최신까지"
              />
            </label>
            <label>
              시작 추첨일
              <input
                type="date"
                value={dateFrom}
                onChange={(e) => editValue(setDateFrom, e.target.value)}
              />
            </label>
            <label>
              종료 추첨일
              <input
                type="date"
                value={dateTo}
                onChange={(e) => editValue(setDateTo, e.target.value)}
              />
            </label>
            <label>
              표시 등수
              <select
                value={rank}
                onChange={(e) => editValue(setRank, e.target.value)}
              >
                <option value="">전체 당첨</option>
                {[1, 2, 3, 4, 5].map((value) => (
                  <option key={value} value={value}>
                    {value}등
                  </option>
                ))}
              </select>
            </label>
          </div>
        </details>
      </section>
      {validationError && <ErrorBox error={validationError} />}
      {error && (
        <div className="history-request-error">
          <ErrorBox error={error} />
          <button
            className="button subtle"
            onClick={() => {
              setOutcome(null);
              setRetry((value) => value + 1);
            }}
          >
            다시 시도
          </button>
        </div>
      )}
      <div className="history-results" aria-busy={loading}>
        {loading ? (
          <div className="loading" role="status">
            <LoaderCircle className="spin" size={22} />
            과거 결과와 비교하고 있습니다.
          </div>
        ) : data ? (
          <>
            <div className="history-caption">
              <span className="badge neutral">과거 대조 결과</span>
              <span>
                {data.compared.toLocaleString()}회차와 비교한 기록입니다.
              </span>
            </div>
            <div className="history-summary">
              <div className="card">
                <span className="muted">비교한 번호</span>
                <Numbers numbers={data.numbers} small />
              </div>
              <div className="card">
                <span className="muted">조건 일치</span>
                <strong>
                  {data.hits}
                  <small>회</small>
                </strong>
              </div>
              <div className="card">
                <span className="muted">최고 등수</span>
                <strong>{data.bestRank ? data.bestRank + "등" : "—"}</strong>
              </div>
              <div className="card">
                <span className="muted">등수별 횟수</span>
                <div className="rank-counts">
                  {data.counts.map((item) => (
                    <span key={item.rank}>
                      {item.rank}등 <b>{item.count}</b>
                    </span>
                  ))}
                </div>
              </div>
            </div>
            <section className="card history-matches">
              <div className="section-top">
                <h2>일치한 과거 회차</h2>
                <span className="muted">{data.total}건</span>
              </div>
              {data.rows.length ? (
                <>
                  <div className="table-scroll">
                    <table className="data-table history-table">
                      <thead>
                        <tr>
                          <th>회차 / 추첨일</th>
                          <th>당첨번호 + 보너스</th>
                          <th>일치 개수</th>
                          <th>대조 결과</th>
                          <th>당시 게임당 배당</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.rows.map(({ draw, result }) => (
                          <tr key={draw.drawNo}>
                            <td data-label="회차 / 추첨일">
                              <strong>제 {draw.drawNo}회</strong>
                              <small>{dateLabel(draw.drawDate)}</small>
                            </td>
                            <td data-label="당첨번호 + 보너스">
                              <Numbers
                                numbers={draw.numbers}
                                bonus={draw.bonusNumber}
                                matched={result.matchedNumbers}
                                small
                              />
                            </td>
                            <td data-label="일치 개수">
                              {result.matchedNumbers.length}개
                              {result.bonusMatched && (
                                <small>보너스 일치</small>
                              )}
                            </td>
                            <td data-label="대조 결과">
                              <Badge result={result} />
                            </td>
                            <td
                              data-label="당시 게임당 배당"
                              className={
                                result.prizePerGame ? "text-teal" : "muted"
                              }
                            >
                              {money(result.prizePerGame)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <Pagination
                    {...data}
                    onChange={(page) => setPagination({ key: filterKey, page })}
                  />
                </>
              ) : (
                <Empty
                  title={
                    data.compared
                      ? "조건에 맞는 과거 당첨이 없어요"
                      : "조회 범위에 수집된 당첨 기록이 없어요"
                  }
                  text={
                    data.compared
                      ? "조회 범위를 넓히거나 다른 조합을 입력해 보세요."
                      : "조회 범위를 넓히거나 회차 데이터를 동기화해 주세요."
                  }
                />
              )}
              <p className="footnote">
                과거 번호의 조건 일치와 당시 배당을 보여주는 비교입니다. 구매
                집계에는 구입한 번호만 반영됩니다.
              </p>
            </section>
          </>
        ) : (
          !error && (
            <section className="card">
              <Empty
                title="이 번호의 지난 기록이 궁금한가요?"
                text="번호 6개를 입력하면 일치한 과거 회차를 자동으로 찾아드려요."
              />
            </section>
          )
        )}
      </div>
    </div>
  );
}

export function HistoryDialog({
  numbers,
  description,
  close,
}: {
  numbers: number[];
  description?: string;
  close: () => void;
}) {
  return (
    <Dialog
      title="과거 당첨 조회"
      description={description}
      className="history-dialog"
      close={close}
    >
      <HistoryLookup key={numbers.join(",")} initialNumbers={numbers} fixed />
    </Dialog>
  );
}
