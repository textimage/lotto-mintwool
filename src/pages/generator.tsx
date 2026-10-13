import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Copy, Dices, Heart, LoaderCircle, Target } from "lucide-react";
import {
  DEFAULT_SCORE_WEIGHTS,
  GENERATION_ALGORITHMS,
  GENERATION_RANGES,
  GENERATION_SPANS,
  defaultBalance,
  generationAlgorithm,
  type GenerationAlgorithm,
  type GenerationResult,
  type GenerationSpan,
  type ScoreWeights,
} from "../../shared/generator";
import { api, useAction, useApp } from "../lib";
import { Ball, Empty, ErrorBox, Numbers, PageTitle } from "../components";
import { FavoriteForm } from "./records";

function optionalNumbers(value: string): number[] {
  if (!value.trim()) return [];
  const pieces = value.trim().split(/[\s,;]+/);
  if (!pieces.every((p) => /^\d{1,2}$/.test(p)))
    throw new Error("포함·제외 번호는 공백 또는 쉼표로 구분해 주세요.");
  return pieces.map(Number);
}
const weightLabels: { key: keyof ScoreWeights; label: string }[] = [
  { key: "frequency", label: "출현 빈도" },
  { key: "recent", label: "최근 출현" },
  { key: "overdue", label: "미출현 기간" },
];
function weightSummary(weights: ScoreWeights) {
  const total = weights.frequency + weights.recent + weights.overdue;
  return weightLabels
    .map(
      ({ key, label }) =>
        `${label} ${total > 0 ? ((weights[key] / total) * 100).toFixed(1) : "0"}%`,
    )
    .join(" · ");
}

function ResultContext({ result }: { result: GenerationResult }) {
  const { options, analysis, possibleCombinations } = result.metadata;
  return (
    <div className="generation-context">
      <strong>{generationAlgorithm(options.algorithm).name}</strong>
      <p>
        생성 당시 조건 · {options.count}게임 · 가능한 조합{" "}
        {possibleCombinations.toLocaleString()}개
      </p>
      {options.included.length > 0 && (
        <p>포함: {options.included.join(", ")}</p>
      )}
      {options.excluded.length > 0 && (
        <p>제외: {options.excluded.join(", ")}</p>
      )}
      {options.balance ? (
        <>
          <p>
            {options.balance.oddCount === null
              ? "홀짝 제한 없음"
              : `홀수 ${options.balance.oddCount} · 짝수 ${6 - options.balance.oddCount}`}
          </p>
          <p>
            {options.balance.ranges
              .map(
                (range, i) =>
                  `${GENERATION_RANGES[i]}: ${range.min === range.max ? range.min : `${range.min}~${range.max}`}개`,
              )
              .join(" / ")}
          </p>
        </>
      ) : (
        <p>홀짝·구간 제한 없음</p>
      )}
      {analysis && (
        <>
          <p>
            분석: {analysis.fromDraw}~{analysis.toDraw}회 중 수집된{" "}
            {analysis.count}회 · 본번호 기준
          </p>
          {analysis.limited && (
            <p className="generation-notice">
              요청한 최근 {analysis.span}회보다 기록이 적어 보유한{" "}
              {analysis.count}회로 계산했습니다.
            </p>
          )}
          {analysis.missingCount > 0 && (
            <p className="generation-notice">
              분석 구간에 {analysis.missingCount}회가 누락되어 있습니다.
              최근성·미출현은 수집된 회차만 기준으로 계산했습니다.
            </p>
          )}
        </>
      )}
      {options.scoreWeights && <p>{weightSummary(options.scoreWeights)}</p>}
    </div>
  );
}

export function GeneratorPage() {
  const [algorithm, setAlgorithm] = useState<GenerationAlgorithm>("random");
  const [count, setCount] = useState(5);
  const [included, setIncluded] = useState("");
  const [excluded, setExcluded] = useState("");
  const [span, setSpan] = useState<GenerationSpan>("100");
  const [balanceEnabled, setBalanceEnabled] = useState(false);
  const [balance, setBalance] = useState(defaultBalance);
  const [scoreWeights, setScoreWeights] = useState({
    ...DEFAULT_SCORE_WEIGHTS,
  });
  const [result, setResult] = useState<GenerationResult | null>(null);
  const [save, setSave] = useState<number[] | null>(null);
  const action = useAction();
  const { toast } = useApp();
  const navigate = useNavigate();
  const definition = generationAlgorithm(algorithm);
  const applyBalance = algorithm === "balanced" || balanceEnabled;
  const games = result?.games ?? [];
  function generate(event: FormEvent) {
    event.preventDefault();
    void action.run(async () => {
      const data = await api<GenerationResult>("/generate", "POST", {
        algorithm,
        count,
        included: optionalNumbers(included),
        excluded: optionalNumbers(excluded),
        ...(definition.requiresHistory ? { span } : {}),
        ...(applyBalance ? { balance } : {}),
        ...(algorithm === "statistical" ? { scoreWeights } : {}),
      });
      setResult(data);
    });
  }
  function updateRange(index: number, field: "min" | "max", value: number) {
    setBalance((current) => ({
      ...current,
      ranges: current.ranges.map((range, i) =>
        i === index ? { ...range, [field]: value } : range,
      ),
    }));
  }
  return (
    <>
      <PageTitle
        eyebrow="MAKE YOUR COMBINATION"
        title="번호 생성"
        description="원하는 생성 방식과 조건을 골라 새로운 조합을 만들어보세요."
      />
      <div className="generator-layout">
        <section className="card generator-form">
          <span className="generator-mark">
            <Dices size={31} />
          </span>
          <h2>오늘의 조합을 만들어볼까요?</h2>
          <p className="muted">6가지 생성 방식 · 나에게 맞는 조건 설정</p>
          <form onSubmit={generate} noValidate>
            <fieldset
              className="form-stack generator-fields"
              disabled={action.busy}
            >
              <label>
                생성 알고리즘
                <select
                  value={algorithm}
                  onChange={(e) => {
                    const next = e.target.value as GenerationAlgorithm;
                    setAlgorithm(next);
                    if (next === "balanced") setBalanceEnabled(true);
                    action.clearError();
                  }}
                >
                  {GENERATION_ALGORITHMS.map((entry) => (
                    <option key={entry.id} value={entry.id}>
                      {entry.name}
                    </option>
                  ))}
                </select>
                <span className="field-hint">{definition.description}</span>
              </label>
              <label>
                생성할 게임 수
                <select
                  value={count}
                  onChange={(e) => setCount(Number(e.target.value))}
                >
                  {[1, 3, 5, 10, 20].map((n) => (
                    <option key={n} value={n}>
                      {n}게임
                    </option>
                  ))}
                </select>
              </label>
              <label>
                꼭 포함할 번호{" "}
                <span className="field-hint">선택 · 최대 6개</span>
                <input
                  value={included}
                  onChange={(e) => setIncluded(e.target.value)}
                  placeholder="예: 7, 21"
                />
              </label>
              <label>
                제외할 번호 <span className="field-hint">선택</span>
                <input
                  value={excluded}
                  onChange={(e) => setExcluded(e.target.value)}
                  placeholder="예: 1, 2, 3"
                />
              </label>
              <details className="generation-settings">
                <summary>
                  세부 설정{applyBalance ? " · 균형 조건 적용 중" : ""}
                </summary>
                <div className="generation-settings-body">
                  {definition.requiresHistory && (
                    <label>
                      분석 범위
                      <select
                        value={span}
                        onChange={(e) =>
                          setSpan(e.target.value as GenerationSpan)
                        }
                      >
                        {GENERATION_SPANS.map((value) => (
                          <option key={value} value={value}>
                            {value === "all" ? "전체 회차" : `최근 ${value}회`}
                          </option>
                        ))}
                      </select>
                      <span className="field-hint">
                        본번호만 사용합니다.{" "}
                        <Link to="/settings">수집 기록 확인</Link>
                      </span>
                    </label>
                  )}
                  {algorithm === "statistical" && (
                    <div className="generation-weight-settings">
                      <h3>통계 가중치</h3>
                      <p className="field-hint">
                        각각 0~100으로 입력하면 합계에 맞춰 비중을 계산합니다.
                      </p>
                      <div className="generation-weight-inputs">
                        {weightLabels.map(({ key, label }) => (
                          <label key={key}>
                            {label}
                            <input
                              type="number"
                              min={0}
                              max={100}
                              step={1}
                              value={
                                Number.isNaN(scoreWeights[key])
                                  ? ""
                                  : scoreWeights[key]
                              }
                              onChange={(e) =>
                                setScoreWeights((current) => ({
                                  ...current,
                                  [key]: e.target.valueAsNumber,
                                }))
                              }
                            />
                          </label>
                        ))}
                      </div>
                      <p className="field-hint">
                        {weightSummary(scoreWeights)}
                      </p>
                      <p className="field-hint">
                        최근 출현은 수집 회차 10개마다 비중이 절반으로
                        줄어듭니다.
                      </p>
                    </div>
                  )}
                  <label className="generation-toggle">
                    <input
                      type="checkbox"
                      checked={applyBalance}
                      disabled={algorithm === "balanced"}
                      onChange={(e) => setBalanceEnabled(e.target.checked)}
                    />
                    <span>
                      홀짝·구간 조건 적용
                      {algorithm === "balanced" && (
                        <small>균형 방식에서는 항상 적용</small>
                      )}
                    </span>
                  </label>
                  {applyBalance && (
                    <div className="generation-balance-settings">
                      <label>
                        홀수 개수
                        <select
                          value={balance.oddCount ?? "any"}
                          onChange={(e) =>
                            setBalance((current) => ({
                              ...current,
                              oddCount:
                                e.target.value === "any"
                                  ? null
                                  : Number(e.target.value),
                            }))
                          }
                        >
                          <option value="any">제한 없음</option>
                          {Array.from({ length: 7 }, (_, n) => (
                            <option key={n} value={n}>
                              홀수 {n}개 · 짝수 {6 - n}개
                            </option>
                          ))}
                        </select>
                      </label>
                      <div className="generation-range-inputs">
                        <div className="generation-range-row generation-range-heading">
                          <span>번호 구간</span>
                          <span>최소</span>
                          <span>최대</span>
                        </div>
                        {balance.ranges.map((range, i) => (
                          <div className="generation-range-row" key={i}>
                            <span>{GENERATION_RANGES[i]}</span>
                            {(["min", "max"] as const).map((field) => (
                              <input
                                key={field}
                                type="number"
                                min={0}
                                max={6}
                                step={1}
                                aria-label={`${GENERATION_RANGES[i]} 구간 ${field === "min" ? "최소" : "최대"} 개수`}
                                value={
                                  Number.isNaN(range[field]) ? "" : range[field]
                                }
                                onChange={(e) =>
                                  updateRange(i, field, e.target.valueAsNumber)
                                }
                              />
                            ))}
                          </div>
                        ))}
                      </div>
                      <p className="field-hint">
                        최소와 최대를 같게 하면 정확히 그 개수로 생성합니다.
                        입력한 조건은 포함·제외 번호와 함께 반드시 지킵니다.
                      </p>
                    </div>
                  )}
                </div>
              </details>
              {action.error && <ErrorBox error={action.error} />}
              <button className="button primary full" disabled={action.busy}>
                {action.busy ? (
                  <LoaderCircle className="spin" size={18} />
                ) : (
                  <Dices size={18} />
                )}
                {games.length ? "새 조합 생성" : "번호 생성하기"}
              </button>
            </fieldset>
          </form>
          {definition.requiresHistory && (
            <p className="footnote">
              통계는 과거 기록을 이용한 번호 선택 기준이며, 점수는 당첨 확률을
              뜻하지 않습니다.
            </p>
          )}
        </section>
        <section className="card generated-results" aria-busy={action.busy}>
          <div className="section-top">
            <h2>생성된 조합</h2>
            {games.length > 0 && (
              <button
                className="text-link"
                disabled={action.busy}
                onClick={() =>
                  void action.run(async () => {
                    await navigator.clipboard.writeText(
                      games.map((g) => g.join(", ")).join("\n"),
                    );
                    toast(
                      "번호를 복사했습니다. 구매 기록에 붙여넣을 수 있어요.",
                    );
                  })
                }
              >
                <Copy size={15} />
                전체 복사
              </button>
            )}
          </div>
          {result ? (
            <>
              <ResultContext result={result} />
              <div className="generated-list">
                {games.map((numbers, i) => (
                  <article className="generated-game" key={numbers.join(",")}>
                    <div className="generated-row">
                      <span className="generated-index">
                        {String(i + 1).padStart(2, "0")}
                      </span>
                      <Numbers numbers={numbers} />
                      <div>
                        <button
                          className="icon-button"
                          aria-label={`${i + 1}번째 조합 나의 번호에 저장`}
                          onClick={() => setSave(numbers)}
                        >
                          <Heart size={19} />
                        </button>
                        <button
                          className="icon-button"
                          aria-label={`${i + 1}번째 조합 과거 조회`}
                          onClick={() =>
                            navigate("/history", { state: { numbers } })
                          }
                        >
                          <Target size={19} />
                        </button>
                      </div>
                    </div>
                    <details className="generated-details">
                      <summary>
                        {i + 1}번째 조합 정보 · 홀수{" "}
                        {result.details[i].oddCount} / 짝수{" "}
                        {6 - result.details[i].oddCount}
                      </summary>
                      <div className="generation-distribution">
                        {result.details[i].rangeCounts.map((value, range) => (
                          <span key={range}>
                            {GENERATION_RANGES[range]}{" "}
                            <strong>{value}개</strong>
                          </span>
                        ))}
                      </div>
                      {result.metadata.analysis && (
                        <>
                          <ul className="generation-scores">
                            {numbers.map((n) => {
                              const info = result.metadata.numberScores[n - 1];
                              return (
                                <li key={n}>
                                  <Ball number={n} small />
                                  <div>
                                    <strong>
                                      선택 점수 {info.score.toFixed(2)} · 가중치{" "}
                                      {info.weight.toFixed(2)}
                                    </strong>
                                    <span>
                                      출현 {info.count}회 · 연속 미출현{" "}
                                      {info.gap}회
                                    </span>
                                    <span>
                                      빈도 {info.frequencyScore.toFixed(2)} /
                                      최근 {info.recentScore.toFixed(2)} /
                                      미출현 {info.gapScore.toFixed(2)}
                                    </span>
                                  </div>
                                </li>
                              );
                            })}
                          </ul>
                          <p className="field-hint">
                            지표는 45개 번호 사이에서 0~1로 환산합니다. 선택
                            가중치는 1 + 4 × 선택 점수이며, 포함 번호는 점수와
                            관계없이 고정합니다.
                          </p>
                        </>
                      )}
                    </details>
                  </article>
                ))}
              </div>
              <p className="footnote">
                하트로 나의 번호에 보관하고, 과녁으로 과거 기록을 확인하세요.
              </p>
            </>
          ) : (
            <Empty
              title="나만의 다음 번호"
              text="알고리즘과 조건을 고르고 생성하기를 누르면 조합이 이곳에 나타납니다."
            />
          )}
        </section>
      </div>
      {save && <FavoriteForm numbers={save} close={() => setSave(null)} />}
    </>
  );
}
