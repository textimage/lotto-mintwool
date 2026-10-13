import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import {
  ArrowUpRight,
  Search,
  Ticket,
  LoaderCircle,
  ChevronRight,
  BarChart3,
  CalendarDays,
} from "lucide-react";
import type { Draw } from "../../shared/domain";
import { estimateAfterTaxPrize, lottoTaxRule } from "../../shared/domain";
import { useApi, money, dateLabel } from "../lib";
import {
  PageTitle,
  Numbers,
  Ball,
  Badge,
  Dialog,
  Empty,
  Loading,
  ErrorBox,
  Pagination,
} from "../components";
import { HistoryLookup } from "../history";

export function HistoryPage() {
  const location = useLocation();
  const initial = (location.state as { numbers?: number[] } | null)?.numbers;
  return (
    <>
      <PageTitle
        eyebrow="HISTORICAL MATCH"
        title="과거 당첨 조회"
        description="나의 조합을 과거 추첨 결과와 비교해 보세요."
      />
      <HistoryLookup
        key={initial?.join("-") ?? "direct"}
        initialNumbers={initial}
      />
    </>
  );
}

export function DrawsPage() {
  const location = useLocation();
  const initialQuery = new URLSearchParams(location.search).get("round") ?? "";
  const [input, setInput] = useState(initialQuery);
  const [query, setQuery] = useState(initialQuery);
  const [page, setPage] = useState(1);
  const [detail, setDetail] = useState<Draw | null>(null);
  const taxRule = detail ? lottoTaxRule(detail.drawDate) : null;
  useEffect(() => {
    const value = new URLSearchParams(location.search).get("round");
    setInput(value ?? "");
    setQuery(value ?? "");
    setPage(1);
  }, [location.search]);
  const { data, loading, error } = useApi<{
    draws: Draw[];
    total: number;
    page: number;
    pageSize: number;
  }>("/draws?" + new URLSearchParams({ q: query, page: String(page) }));
  return (
    <>
      <PageTitle
        eyebrow="DRAW ARCHIVE"
        title="회차별 결과"
        description="첫 회부터 최신까지, 추첨 결과와 등수별 배당을 확인하세요."
      >
        <Link to="/settings" className="button subtle">
          <CalendarDays size={17} />
          데이터 갱신
        </Link>
      </PageTitle>
      <div className="card filter-bar draw-filters">
        <form
          className="search-form"
          onSubmit={(e) => {
            e.preventDefault();
            setQuery(input.trim().replaceAll(".", "-"));
            setPage(1);
          }}
        >
          <Search size={19} />
          <input
            aria-label="회차 또는 추첨일 검색"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="회차 또는 추첨일 검색 (예: 1245, 2026-10)"
          />
          <button className="button primary-soft">검색</button>
        </form>
        <button
          className="button subtle draw-reset"
          onClick={() => {
            setInput("");
            setQuery("");
            setPage(1);
          }}
        >
          전체 보기
        </button>
        {data && (
          <span className="filter-count">
            총 <strong>{data.total.toLocaleString()}</strong>회차
          </span>
        )}
      </div>
      {error && <ErrorBox error={error} />}
      {!data && loading ? (
        <Loading />
      ) : (
        data && (
          <section className="card draw-archive">
            {data.draws.length ? (
              <>
                <div className="table-scroll">
                  <table className="data-table draw-table">
                    <thead>
                      <tr>
                        <th>회차 / 추첨일</th>
                        <th>당첨번호 + 보너스</th>
                        <th>1등 게임당 배당</th>
                        <th>수집 상태</th>
                        <th></th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.draws.map((draw) => (
                        <tr key={draw.drawNo}>
                          <td>
                            <strong>제 {draw.drawNo}회</strong>
                            <small>{dateLabel(draw.drawDate)}</small>
                          </td>
                          <td>
                            <Numbers
                              numbers={draw.numbers}
                              bonus={draw.bonusNumber}
                              small
                            />
                          </td>
                          <td>
                            <strong>
                              {draw.status === "complete"
                                ? draw.ranks[0].numWinners === 0
                                  ? "당첨자 없음"
                                  : money(draw.ranks[0].prizePerGame)
                                : "집계 중"}
                            </strong>
                          </td>
                          <td>
                            <span
                              className={
                                "badge " +
                                (draw.status === "complete"
                                  ? "neutral"
                                  : "status-tallying")
                              }
                            >
                              {draw.status === "complete"
                                ? "집계 완료"
                                : "집계 중"}
                            </span>
                            <small>
                              {draw.source === "official"
                                ? "동행복권"
                                : "GitHub"}
                            </small>
                          </td>
                          <td>
                            <button
                              className="button subtle"
                              onClick={() => setDetail(draw)}
                              aria-label={`${draw.drawNo}회 상세 결과`}
                            >
                              상세
                              <ChevronRight size={15} />
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <Pagination {...data} unit="회차" onChange={setPage} />
              </>
            ) : (
              <Empty
                title="해당 회차를 찾지 못했어요"
                text="검색어를 확인하거나 설정에서 누락 회차를 가져와 주세요."
              />
            )}
          </section>
        )
      )}
      {detail && (
        <Dialog
          title={`제 ${detail.drawNo}회 당첨 결과`}
          description={dateLabel(detail.drawDate) + " 추첨"}
          close={() => setDetail(null)}
          className="draw-detail-dialog"
        >
          <div className="draw-detail">
            <Numbers numbers={detail.numbers} bonus={detail.bonusNumber} />
            <div className="table-scroll">
              <table className="data-table draw-detail-table">
                <thead>
                  <tr>
                    <th>등수</th>
                    <th>당첨 게임</th>
                    <th>게임당 세전 배당</th>
                    <th>게임당 세후 예상액</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.ranks.map((r) => (
                    <tr key={r.rank}>
                      <td>
                        <span className="rank-dot">{r.rank}</span>
                        {r.rank}등
                      </td>
                      <td>{r.numWinners?.toLocaleString() ?? "미확정"}</td>
                      <td>
                        {detail.status === "complete"
                          ? r.numWinners === 0
                            ? "당첨자 없음"
                            : money(r.prizePerGame)
                          : "집계 중"}
                      </td>
                      <td className="text-teal">
                        {detail.status === "complete"
                          ? r.numWinners === 0
                            ? "당첨자 없음"
                            : money(
                                estimateAfterTaxPrize(
                                  r.prizePerGame,
                                  detail.drawDate,
                                ),
                              )
                          : "집계 중"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="footnote">
              출처:{" "}
              {detail.source === "official"
                ? "동행복권 공식 API"
                : "lottogo-python"}{" "}
              · 당첨금 합계는 세전 배당 기준입니다.
            </p>
            {taxRule && (
              <p className="footnote tax-basis">
                세후 계산 기준: {detail.drawDate.slice(0, 4)}년 추첨 당시 기준 ·{" "}
                {money(taxRule.exemptLimit)} 이하 비과세 · 지방세 포함{" "}
                {taxRule.higherRateThreshold === null
                  ? "22% 단일 세율"
                  : `${money(taxRule.higherRateThreshold)} 이하분 22%, 초과분 33%`}
                .
                <br />
                공시 배당에 당시 세율을 적용한 예상액입니다. 실제
                수령일·필요경비·지급기관의 세액 절사 차이는 포함하지 않으며,
                계산한 세액의 원 미만은 버립니다.{" "}
                <a
                  className="text-link"
                  href={
                    detail.drawDate < "2004-01-01"
                      ? "https://law.go.kr/LSW/lsInfoP.do?lsiSeq=1138"
                      : detail.drawDate < "2023-01-01"
                        ? "https://taxlaw.nts.go.kr/qt/USEQTA002P.do?ntstDcmId=010000000000042752"
                        : "https://www.dhlottery.co.kr/guide/wnrGuide?tab=3"
                  }
                  target="_blank"
                  rel="noreferrer"
                >
                  기준 안내
                </a>
              </p>
            )}
            {detail.sourceCommit && (
              <p className="commit-label">
                원본 커밋 {detail.sourceCommit.slice(0, 12)}
              </p>
            )}
          </div>
        </Dialog>
      )}
    </>
  );
}

interface Statistics {
  span: string;
  count: number;
  frequencies: {
    number: number;
    count: number;
    lastSeen: number | null;
    gap: number | null;
  }[];
  odd: number;
  even: number;
  ranges: number[];
  latest: number | null;
}
export function StatisticsPage() {
  const [span, setSpan] = useState("100");
  const { data, loading, error } = useApi<Statistics>("/stats?span=" + span);
  const [sort, setSort] = useState("number");
  const hot = data
    ? [...data.frequencies]
        .sort((a, b) => b.count - a.count || a.number - b.number)
        .slice(0, 6)
    : [];
  const cold = data
    ? [...data.frequencies]
        .sort(
          (a, b) => (b.gap ?? 10000) - (a.gap ?? 10000) || a.number - b.number,
        )
        .slice(0, 6)
    : [];
  const max = data ? Math.max(1, ...data.frequencies.map((f) => f.count)) : 1;
  const frequencies = data
    ? [...data.frequencies].sort((a, b) =>
        sort === "count"
          ? b.count - a.count || a.number - b.number
          : a.number - b.number,
      )
    : [];
  return (
    <>
      <PageTitle
        eyebrow="NUMBER INSIGHTS"
        title="번호 통계"
        description="과거 기록에 담긴 번호의 빈도와 분포를 살펴보세요."
      >
        <label className="inline">
          <span className="muted">집계 범위</span>
          <select value={span} onChange={(e) => setSpan(e.target.value)}>
            <option value="10">최근 10회</option>
            <option value="50">최근 50회</option>
            <option value="100">최근 100회</option>
            <option value="all">전체 회차</option>
          </select>
        </label>
      </PageTitle>
      {error && <ErrorBox error={error} />}
      {!data && loading ? (
        <Loading />
      ) : (
        data &&
        (data.count ? (
          <>
            <div className="insight-grid">
              <section className="card insight-card">
                <span className="insight-tag">
                  <BarChart3 size={15} />
                  많이 나온 번호
                </span>
                <Numbers numbers={hot.map((f) => f.number)} />
                <p>선택한 {data.count}회차에서 출현 빈도가 높은 순서입니다.</p>
              </section>
              <section className="card insight-card">
                <span className="insight-tag cold">
                  <CalendarDays size={15} />
                  최근 기다림이 긴 번호
                </span>
                <Numbers numbers={cold.map((f) => f.number)} />
                <p>
                  전체 수집 기록의 마지막 출현 이후 경과 회차를 기준으로 합니다.
                </p>
              </section>
            </div>
            <section className="card frequency-card">
              <div className="section-top">
                <div>
                  <h2>번호별 출현 빈도</h2>
                  <p className="muted">
                    본번호 기준 · 보너스 번호 제외 · {data.count}회차
                  </p>
                </div>
                <select
                  aria-label="번호 통계 정렬"
                  value={sort}
                  onChange={(e) => setSort(e.target.value)}
                >
                  <option value="number">번호순</option>
                  <option value="count">빈도순</option>
                </select>
              </div>
              <div className="frequency-grid">
                {frequencies.map((f) => (
                  <div className="frequency-item" key={f.number}>
                    <Ball number={f.number} small />
                    <div className="frequency-track">
                      <span style={{ height: `${(f.count / max) * 100}%` }} />
                    </div>
                    <strong>
                      {f.count}
                      <small>회</small>
                    </strong>
                    <span className="frequency-gap">
                      {f.gap === null ? "출현 기록 없음" : f.gap + "회 전"}
                    </span>
                  </div>
                ))}
              </div>
            </section>
            <div className="distribution-grid">
              <section className="card">
                <div className="section-top">
                  <h2>홀짝 분포</h2>
                  <span className="muted">{data.count * 6}개 본번호</span>
                </div>
                <div className="odd-even">
                  <div
                    className="donut"
                    style={{
                      background: `conic-gradient(var(--accent) 0 ${((data.odd / (data.odd + data.even)) * 100).toFixed(2)}%, #dedee5 0 100%)`,
                    }}
                  >
                    <span>
                      홀수
                      <strong>
                        {((data.odd / (data.odd + data.even)) * 100).toFixed(1)}
                        %
                      </strong>
                    </span>
                  </div>
                  <div>
                    <p>
                      <i className="legend teal" />
                      홀수 <strong>{data.odd.toLocaleString()}개</strong>
                    </p>
                    <p>
                      <i className="legend gray" />
                      짝수 <strong>{data.even.toLocaleString()}개</strong>
                    </p>
                  </div>
                </div>
              </section>
              <section className="card">
                <div className="section-top">
                  <h2>번호 구간 분포</h2>
                  <span className="muted">본번호 기준</span>
                </div>
                <div className="range-bars">
                  {data.ranges.map((value, i) => (
                    <div key={i}>
                      <span>
                        {i * 10 + 1}~{i === 4 ? 45 : (i + 1) * 10}
                      </span>
                      <div className="range-track">
                        <span
                          className={"range-" + (i + 1)}
                          style={{
                            width: `${(value / Math.max(...data.ranges)) * 100}%`,
                          }}
                        />
                      </div>
                      <strong>{value.toLocaleString()}</strong>
                    </div>
                  ))}
                </div>
              </section>
            </div>
            <p className="footnote">
              통계는 수집된 과거 결과의 참고 정보입니다. 실제 수집 범위는
              설정에서 확인할 수 있습니다.
            </p>
          </>
        ) : (
          <section className="card">
            <Empty
              title="통계를 위한 회차가 아직 없어요"
              text="설정에서 최초 데이터를 가져와 주세요."
            >
              <Link className="button primary" to="/settings">
                데이터 가져오기
              </Link>
            </Empty>
          </section>
        ))
      )}
    </>
  );
}
