import test from "node:test";
import assert from "node:assert/strict";
import { parseNumbers, parsePurchasePaste } from "../shared/domain.js";

const games = [
  [11, 16, 17, 23, 35, 39],
  [1, 5, 18, 19, 40, 43],
  [3, 4, 26, 29, 41, 43],
  [11, 27, 32, 36, 41, 42],
  [9, 13, 20, 23, 24, 45],
];

// The complete text supplied by the user, including blank lines between numbers.
const receipt = `1246회
발행일
2026/10/12 (월) 16:48:50
추첨일
2026/10/17
지급기한
2027/10/18
65715
06837
67363
13873
04724
51533
A
수동
11

16

17

23

35

39

B
수동
1

5

18

19

40

43

C
수동
3

4

26

29

41

43

D
수동
11

27

32

36

41

42

E
자동
9

13

20

23

24

45`;

test("full receipt extracts the supplied five games, round and draw date", () => {
  assert.deepEqual(parsePurchasePaste(receipt), {
    games,
    drawNo: 1246,
    drawDate: "2026-10-17",
  });
  assert.deepEqual(
    parsePurchasePaste(
      receipt.replaceAll("\n\n", "\n").replaceAll("\n", "\r\n"),
    ),
    parsePurchasePaste(receipt),
  );
});

test("inline games, special whitespace and Markdown numbers work without a round", () => {
  const text = games
    .map(
      (numbers, i) =>
        `${String.fromCharCode(65 + i)}\t${i === 4 ? "자동" : "수동"}\u00a0` +
        numbers.map((n) => `**${n}**`).join("\u202f"),
    )
    .join("\r\n\r\n");
  assert.deepEqual(parsePurchasePaste(text), { games });
  assert.deepEqual(parsePurchasePaste("A. __45__; 21, 13 3 2 1"), {
    games: [[1, 2, 3, 13, 21, 45]],
  });
  assert.deepEqual(parsePurchasePaste("A 반자동\n1 2 3 4 5 6"), {
    games: [[1, 2, 3, 4, 5, 6]],
  });
  assert.deepEqual(parsePurchasePaste("A\n수동 1 2 3 4 5 6"), {
    games: [[1, 2, 3, 4, 5, 6]],
  });
});

test("one to five labelled games and identical games are retained", () => {
  for (let count = 1; count <= 5; count++) {
    const input = Array.from(
      { length: count },
      (_, i) => `${String.fromCharCode(65 + i)} 수동 1 2 3 4 5 6`,
    ).join("\n");
    assert.deepEqual(parsePurchasePaste(input), {
      games: Array.from({ length: count }, () => [1, 2, 3, 4, 5, 6]),
    });
  }
});

test("totals and repeated verification numbers cannot become game numbers", () => {
  for (const footer of [
    "합계\n5,000 원\n65715 06837 67363 13873 04724 51533",
    "합계 5,000원\n65715\n06837\n67363\n13873\n04724\n51533",
    "₩5,000\n657150683767363138730472451533",
    "65715 06837 67363 13873 04724 51533",
  ]) {
    assert.deepEqual(
      parsePurchasePaste(receipt + "\n" + footer),
      parsePurchasePaste(receipt),
    );
  }
});

test("round metadata calculates dates and validates labelled draw dates only", () => {
  const input = "A 자동 1 2 3 4 5 6";
  assert.deepEqual(parsePurchasePaste("제 1246회\n" + input), {
    games: [[1, 2, 3, 4, 5, 6]],
    drawNo: 1246,
    drawDate: "2026-10-17",
  });
  assert.deepEqual(parsePurchasePaste("추첨일: 2026/10/17 (토)\n" + input), {
    games: [[1, 2, 3, 4, 5, 6]],
    drawNo: 1246,
    drawDate: "2026-10-17",
  });
  assert.throws(
    () => parsePurchasePaste(receipt.replace("2026/10/17", "2026/10/10")),
    /회차와 추첨일이 일치하지/,
  );
  for (const date of ["2026/10/18", "2026/02/31", "2026년10월17일", ""]) {
    assert.throws(() =>
      parsePurchasePaste(`1246회\n추첨일\n${date}\n${input}`),
    );
  }
  for (const round of ["0회", "10001회", "1246회\n1245회"]) {
    assert.throws(() => parsePurchasePaste(round + "\n" + input));
  }
});

test("malformed games fail as a whole and identify the affected game", () => {
  for (const numbers of [
    "1 2 3 4 5",
    "1 2 3 4 5 6 7",
    "1 2 3 4 5 5",
    "0 2 3 4 5 6",
    "1 2 3 4 5 46",
    "1 2 3 4 5 6.1",
    "1a 2 3 4 5 6",
    "",
  ]) {
    assert.throws(
      () => parsePurchasePaste(`A 수동 1 2 3 4 5 6\nB 자동\n${numbers}`),
      /B 게임:/,
    );
  }
  assert.throws(
    () => parsePurchasePaste("A\n1 2 3 4 5\n합계\n1,000원"),
    /A 게임:/,
  );
  assert.throws(() =>
    parsePurchasePaste("1246회\n657150683767363138730472451533"),
  );
  assert.throws(() => parsePurchasePaste("A 1 2 3 4 5 6\nA 7 8 9 10 11 12"));
  assert.throws(() => parsePurchasePaste("F 수동 1 2 3 4 5 6"));
  assert.throws(() => parsePurchasePaste(receipt + "\n" + receipt));
});

test("ordinary number pastes and verification numbers keep existing input behavior", () => {
  for (const input of [
    "",
    "1 2 3 4 5 6",
    "1, 2, 3, 4, 5, 6\n7 8 9 10 11 12",
    "657150683767363138730472451533",
    "65715\n06837\n67363\n13873\n04724\n51533",
  ]) {
    assert.equal(parsePurchasePaste(input), null);
  }
  assert.deepEqual(parseNumbers("1, 2, 3, 4, 5, 6"), [1, 2, 3, 4, 5, 6]);
});
