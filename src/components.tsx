import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import {
  X,
  ChevronLeft,
  ChevronRight,
  LoaderCircle,
  CircleAlert,
  Dices,
  Grid3X3,
} from "lucide-react";
import { dateLabel, money } from "./lib";
import type { GameResult, TicketView } from "../shared/domain";

export function Ball({
  number,
  dim = false,
  small = false,
  marked = false,
}: {
  number: number;
  dim?: boolean;
  small?: boolean;
  marked?: boolean;
}) {
  return (
    <span
      className={`ball ball-${Math.ceil(number / 10)}${dim ? " dim" : ""}${small ? " small" : ""}${marked ? " marked" : ""}`}
      aria-label={`${number}${marked ? " 일치" : ""}`}
    >
      {number}
    </span>
  );
}
export function Numbers({
  numbers,
  bonus,
  matched,
  small = false,
}: {
  numbers: number[];
  bonus?: number;
  matched?: number[];
  small?: boolean;
}) {
  return (
    <div className={"numbers" + (small ? " compact" : "")}>
      {numbers.map((n) => (
        <Ball
          key={n}
          number={n}
          dim={matched !== undefined && !matched.includes(n)}
          marked={matched?.includes(n)}
          small={small}
        />
      ))}
      {bonus !== undefined && (
        <>
          <span className="bonus-plus">+</span>
          <Ball number={bonus} small={small} />
        </>
      )}
    </div>
  );
}
export function PageTitle({
  eyebrow,
  title,
  description,
  children,
}: {
  eyebrow: string;
  title: string;
  description?: string;
  children?: ReactNode;
}) {
  return (
    <div className="page-title">
      <div>
        <p className="eyebrow">{eyebrow}</p>
        <h1>{title}</h1>
        {description && <p className="page-description">{description}</p>}
      </div>
      {children && <div className="page-actions">{children}</div>}
    </div>
  );
}
export function Empty({
  title,
  text,
  children,
}: {
  title: string;
  text: string;
  children?: ReactNode;
}) {
  return (
    <div className="empty">
      <span className="empty-icon">
        <Dices size={28} />
      </span>
      <h3>{title}</h3>
      <p>{text}</p>
      {children}
    </div>
  );
}
export function Loading() {
  return (
    <div className="loading" role="status">
      <LoaderCircle className="spin" size={22} /> 기록을 불러오는 중입니다.
    </div>
  );
}
export function ErrorBox({ error }: { error: string }) {
  return (
    <div className="error-box" role="alert">
      <CircleAlert size={18} />
      {error}
    </div>
  );
}
export function Dialog({
  title,
  description,
  children,
  close,
  className = "",
}: {
  title: string;
  description?: string;
  children: ReactNode;
  close: () => void;
  className?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const id = useId();
  useEffect(() => {
    const dialog = ref.current;
    const previousFocus = document.activeElement;
    const previousOverflow = document.body.style.overflow;
    dialog?.showModal();
    document.body.style.overflow = "hidden";
    return () => {
      dialog?.close();
      document.body.style.overflow = previousOverflow;
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected)
        previousFocus.focus({ preventScroll: true });
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className={"dialog " + className}
      aria-labelledby={id}
      onCancel={close}
      onClick={(event) => {
        if (event.target !== ref.current || !ref.current) return;
        const bounds = ref.current.getBoundingClientRect();
        if (
          event.clientX < bounds.left ||
          event.clientX > bounds.right ||
          event.clientY < bounds.top ||
          event.clientY > bounds.bottom
        )
          close();
      }}
    >
      <div className="dialog-inner">
        <div className="dialog-heading">
          <div>
            <h2 id={id}>{title}</h2>
            {description && <p>{description}</p>}
          </div>
          <button className="icon-button" aria-label="닫기" onClick={close}>
            <X size={22} />
          </button>
        </div>
        {children}
      </div>
    </dialog>
  );
}
export function NumberInput({
  value,
  onChange,
  showHint = true,
}: {
  value: string;
  onChange: (value: string) => void;
  showHint?: boolean;
}) {
  const [grid, setGrid] = useState(false);
  const id = useId();
  const selected = value
    .split(/[\s,;]+/)
    .filter((v) => /^\d+$/.test(v))
    .map(Number);
  function toggle(n: number) {
    const next = selected.includes(n)
      ? selected.filter((v) => v !== n)
      : selected.length < 6
        ? [...selected, n]
        : selected;
    onChange(next.sort((a, b) => a - b).join(", "));
  }
  return (
    <div className="number-input">
      <label htmlFor={id} className="number-input-label">
        <span>번호 6개</span>{" "}
        <span className="field-hint">1~45 · 중복 없이</span>
      </label>
      <div className="input-with-button">
        <input
          id={id}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="4 5 25 28 32 42"
          inputMode="text"
          aria-describedby={showHint ? id + "-hint" : undefined}
          autoComplete="off"
        />
        <button
          type="button"
          className="button subtle"
          aria-expanded={grid}
          onClick={() => setGrid(!grid)}
        >
          <Grid3X3 size={17} />
          <span>번호판</span>
        </button>
      </div>
      {showHint && (
        <p id={id + "-hint"} className="field-hint number-input-hint">
          공백 또는 쉼표로 구분해 입력하세요.
        </p>
      )}
      {grid && (
        <div className="number-grid">
          {Array.from({ length: 45 }, (_, i) => i + 1).map((n) => (
            <button
              type="button"
              key={n}
              aria-label={`${n}번 ${selected.includes(n) ? "선택 해제" : "선택"}`}
              aria-pressed={selected.includes(n)}
              className={selected.includes(n) ? "selected" : ""}
              onClick={() => toggle(n)}
            >
              {n}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
export function Badge({ result }: { result: GameResult }) {
  return (
    <span className={"badge status-" + result.status}>{result.label}</span>
  );
}
export function TicketCard({
  ticket,
  actions,
  showRound = true,
}: {
  ticket: TicketView;
  actions?: ReactNode;
  showRound?: boolean;
}) {
  return (
    <article className="card ticket-card">
      <div className="ticket-heading">
        <div className="ticket-title">
          {showRound && (
            <>
              <span className="ticket-round">제 {ticket.drawNo}회</span>
              <span className="muted">{dateLabel(ticket.drawDate)}</span>
            </>
          )}
          <span className="source-pill">
            {ticket.source === "qr"
              ? "QR 등록"
              : ticket.source === "favorite"
                ? "나의 번호"
                : "직접 입력"}
          </span>
        </div>
        {actions}
      </div>
      <div className="ticket-games">
        {ticket.games.map((game, i) => (
          <div className="ticket-game" key={game.id ?? i}>
            <span className="game-index">
              {i < 26 ? String.fromCharCode(65 + i) : i + 1}
            </span>
            <Numbers
              numbers={game.numbers}
              matched={
                ["pending", "missing"].includes(ticket.results[i].status)
                  ? undefined
                  : ticket.results[i].matchedNumbers
              }
              small
            />
            <span className="game-quantity">{game.quantity}개</span>
            <div className="game-outcome">
              <Badge result={ticket.results[i]} />
              <strong
                className={
                  ticket.results[i].status === "won" ? "text-teal" : "muted"
                }
              >
                {money(ticket.results[i].prizeTotal)}
              </strong>
            </div>
          </div>
        ))}
      </div>
      <div className="ticket-footer">
        {ticket.memo && <span className="ticket-memo">{ticket.memo}</span>}
        <div>
          <span>
            구매번호수{" "}
            {ticket.games
              .reduce((sum, game) => sum + game.quantity, 0)
              .toLocaleString()}
            개
          </span>
          <span>
            확정 당첨금 <strong>{money(ticket.confirmedPrize)}</strong>
          </span>
        </div>
      </div>
    </article>
  );
}
export function Pagination({
  page,
  total,
  pageSize,
  onChange,
  unit = "건",
}: {
  page: number;
  total: number;
  pageSize: number;
  onChange: (page: number) => void;
  unit?: string;
}) {
  if (total <= pageSize) return null;
  const last = Math.ceil(total / pageSize);
  return (
    <div className="pagination">
      <button
        className="button subtle"
        aria-label="이전 페이지"
        disabled={page <= 1}
        onClick={() => onChange(page - 1)}
      >
        <ChevronLeft size={17} />
      </button>
      <span>
        {page} / {last} 페이지 · {total.toLocaleString()}
        {unit}
      </span>
      <button
        className="button subtle"
        aria-label="다음 페이지"
        disabled={page >= last}
        onClick={() => onChange(page + 1)}
      >
        <ChevronRight size={17} />
      </button>
    </div>
  );
}
