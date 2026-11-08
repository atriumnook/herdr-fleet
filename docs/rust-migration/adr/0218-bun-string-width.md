# screen の文字幅を、Bun 1.4.4 の表と grapheme の決まりを写して数える

- 状態: 採用
- 決めた日: 2026-11-09
- Issue: #218
- 置き換える: 0193-phase-2-dependencies(一部だけ。「文字の幅と grapheme」の、grapheme の幅と文字列の幅の決まり(115〜116 行)、依存の unicode-width(29 行、201 行)、検討した代わりの「`Bun.stringWidth` を自前の幅の表で写す」を選ばなかった理由(162 行)。unicode-segmentation と `Intl.Segmenter` を比べた結果と、エスケープシーケンスの状態機械の決まりは残る)、0195-screen-foundation(一部だけ。「`text.rs` に置くもの」の文字の幅の項(107 行)。`grapheme_width` はなくなる)

## 状況

screen の `string_width` と `grapheme_width`(#195)は、エスケープシーケンスを飛ばしたあとの文字を unicode-width 0.2.3 で数えていた。Bun 1.4.4 の `Bun.stringWidth` とは、次の 2 種類の文字列で幅が違う(Issue #218 の本文とコメント。値は Bun 1.4.4 で測った)。

- 一般カテゴリが Mc(spacing combining mark)の文字: `का`(U+0915 U+093E)は Bun が 1、Rust が 2。`किताब` は Bun が 3、Rust が 5
- Bun が grapheme の決まりで 2 桁にする並び: `❤ ZWJ`(U+2764 U+200D)と `🇦 U+0301` は、Bun が 2、Rust が 1

ADR `0193-phase-2-dependencies` は、画面の corpus の `screen.txt` に出る文字だけで比べたので、この 2 種類はその確認の範囲の外にあった。幅を使うのは Claude の問いのプレビューの読み取り(`claude/preview.rs`。TypeScript では `server/prompt.ts:426-451` の `indexAtColumn` と `withoutPreview`)だけである。選択肢の文字に Mc の文字があると、Rust は枠の列を TypeScript より右に数え、枠を選択肢から切り離せない。

coordinator は、Issue の 3 つの候補のうち「Bun の表を写す」を選んだ(#218 のコメント)。外部の crate を増やさずに済むためである。

Bun の `Bun.stringWidth`(tag `bun-v1.4.4`、commit `38afee6c84fcf48c0edb2466aa4b27d287a59c30`)は、次のように数える。

- `src/jsc/bindings/stringWidthTables.h` の 3 段の表で、code point ごとに 1 byte を引く。bit 0〜4 が grapheme の break class(grapheme break property と Indic conjunct break を合わせた 17 種類)、bit 5〜6 が幅(0、1、2、3 は East Asian Ambiguous)、bit 7 が Emoji の性質。表は `scripts/generate-stringwidth-tables.mjs` が Unicode 17.0.0 の UCD(EastAsianWidth.txt、extracted/DerivedGeneralCategory.txt、emoji/emoji-data.txt)から作る。ただし break class は既存の header から引き継ぐので、この script を UCD のファイルだけで走らせることはできない
- `src/jsc/bindings/stringWidth.cpp` の `computeGraphemeBreakNoControl`(uucode から移したもの)が、UAX #29 と GB9c の決まりで grapheme を区切る。`Intl.Segmenter`(ICU)とは別の実装である
- `GraphemeState::width` が grapheme の幅を決める。regional indicator の組、keycap、肌の色か ZWJ の付いた Emoji は 2、regional indicator 1 つは 1、VS15・VS16 の付いた grapheme は最初の文字の幅(VS16 と Emoji の性質の組み合わせなら 2)、それ以外は文字の幅の和(1023 で飽和する)
- UTF-16 の文字列では、`UTF16WidthAccumulator::addRun` が、ASCII と、`highway_strings.cpp` の `ClassifyBulkUTF16Unit` が挙げる文字(U+00A0〜U+02FF のうち U+00A9、U+00AD、U+00AE 以外、ギリシア文字、キリル文字、かな、CJK 統合漢字と拡張 A、ハングルの音節、全角形)を、break の決まりを通さずにまとめて数える。そのため、これらの文字の前では必ず grapheme が切れる。たとえば `U+0600 a U+FE0F` は、UAX #29 なら 1 つの grapheme で幅 0 だが、Bun は 1 を返す
- Latin-1 だけの文字列(JavaScriptCore の 8 bit の文字列)は別の経路で数えるが、Latin-1 の文字だけなら UTF-16 の経路と同じ値になる(Latin-1 の範囲に、grapheme の幅の決まりを変える並びがない)。そのため、文字列が内部で Latin-1 と UTF-16 のどちらで持たれていても、幅は変わらない

`claude/preview.rs` は、`Intl.Segmenter` の grapheme(unicode-segmentation)ごとに `Bun.stringWidth(segment)` を足す。Bun はその segment を自分の決まりで数え直すので、segment の幅は `string_width(segment)` と同じである。

module の形と表の形は、crate の中の口に関わるので、lead の決まりのとおり architect(fleet の run `19bc2a46`、`spawn --role architect --read-only`)に、lead の案と 3 つの問いを渡して聞いた。この ADR の決定は、その答えのとおりである。答えは、書くパスを Issue の割り当てより広げる形だったので、coordinator に了承を得た。

## 決定

### 表の形

Bun の表は、同じ byte を持つ code point の連なりごとに、先頭の code point と byte の組 `(u32, u8)` を先頭の昇順に並べた配列にし、二分探索で引く(Bun 1.4.4 で 2,638 組)。byte は `stringWidthTables.h` の stage3 の値をそのまま持つ。表を作る script は、連なりにまとめるだけで、byte の bit の意味を読まない。

- 大きさ: `table.rs` は 2,655 行、メモリーは 21,104 byte(2,638 × 8)。3 段の配列をそのまま写すと、元の header が 162,603 byte、メモリーは 49,185 byte になる
- 1 行が「code point の範囲と byte」なので、Bun が UCD を更新したとき、差分に出るのは変わった範囲の行だけになる。3 段の配列では、stage2 の block の番号が振り直されると、変わっていない code point の行まで差分に出る
- 引く速さ: 1 文字あたり最大 12 回の比較で、3 段の配列は 3 回の読み出しになる。幅を求めるのはプレビューの枠の列を求める 2 か所だけなので、この差は選ぶ理由にしなかった

### module の形

- `rust/crates/screen/src/text/width/table.rs`(生成するファイル): 連なりの配列と、`pub(super) fn packed(char) -> u8`。bit の意味は書かず、`width.rs` の `classify` が読むとだけ書く
- `rust/crates/screen/src/text/width.rs`(`text.rs` の `mod width;`): byte の bit の意味(`classify`)、break の決まり(`breaks`)、`GraphemeState` の決まり(`Grapheme`)、まとめて数える文字の集合(`in_bulk_run`)。外に見せるのは `pub(super) struct WidthCounter` の `push(char)` と `finish()` だけ
- `rust/crates/screen/src/text.rs`: エスケープシーケンスの状態機械と、`string_width`(エスケープシーケンスを飛ばし、残りの文字を `WidthCounter` に渡す)、`graphemes`
- `grapheme_width` は消す。`claude/preview.rs` は `string_width(grapheme)` を呼ぶ。TypeScript が segment ごとに `Bun.stringWidth(segment)` を呼ぶ(`server/prompt.ts:433`)のと同じ形になる
- `lib.rs` と crate の公開の口は変えない

Bun が文字をまとめて数える経路は、1 文字ずつ「grapheme を切り、その文字から新しい grapheme を始め、break の状態を戻す」(`seedFromBulkRun`)扱いにした。まとめて数える文字の固定の幅(1 か 2)は、表の幅(ambiguous を 1 とする)と、U+0080〜U+FFFF のすべての該当する文字で一致した(architect が確かめた。違いは 0 件)。そのため、1 文字ずつの扱いでも、Bun が連なりごとに数える値と同じになる。

### テスト

テストはすべて crate の中の単体テストにし、`preview.rs` が呼ぶのと同じ `string_width` を通して確かめる。`tests/width.rs` は作らず、テストのための公開の口も足さない。期待値は Bun 1.4.4 の `Bun.stringWidth` で測った値である。

1. 既存の `string_width` の 31 の文字列は、期待値を変えずに残した。`grapheme_width` の 5 つの assert は、同じ期待値のまま `string_width` の assert にした
2. #218 の文字列と、grapheme の幅の決まりの各場合を見る 37 の文字列(`text.rs` の `counts_marks_and_emoji_sequences_as_bun_string_width`)
3. 2 文字の組の行列(`width.rs` の `counts_every_pair_of_kinds_of_characters_as_bun_string_width`)。代表は、(byte、まとめて数える文字か)の組ごとに code point の順で最初の 1 文字(Bun 1.4.4 で 37 組)と、`GraphemeState` が code point そのものを調べる U+00A9、U+00AE、U+20E3、U+FE0E、U+FE0F の 40 文字で、40 × 40 の 1,600 組の `Bun.stringWidth` を持つ。regional indicator、肌の色、ZWJ は、それぞれの break class の文字の集合と一致する(26、5、1 文字。architect が確かめた)ので、組の代表で足りる。break の決まりと `GraphemeState::width` が文字から読むのは、byte、まとめて数える文字か、この 5 つの code point だけなので、2 文字のすべての組み合わせの振る舞いを毎回確かめられる
4. 表のデータ(`width.rs` の `classifies_every_code_point_as_buns_table_does`): すべての scalar value を panic せずに引けること(連なりが U+0000 から始まり、break class がすべて 17 種類のどれかであること)と、Bun 自身が表に置いた検査(`stringWidth.cpp:86-105` の `static_assert`)の値
5. grapheme の幅の和が 1023 で止まること(`width.rs` の `saturates_a_graphemes_width_as_bun_does`。ハングルの初声の字母は互いにつながり(GB6)、1 文字が 2 桁)

### 依存

unicode-width をワークスペースから外す(`rust/Cargo.toml`、`rust/crates/screen/Cargo.toml`、`rust/Cargo.lock`)。#218 のあと、screen のどこも使わない(`cargo tree -i unicode-width --workspace` が示す依存元は screen だけだった)。新しい crate は足さない。

### 出典

`NOTICE` に、Bun(MIT License、tag `bun-v1.4.4`、commit `38afee6c84fcf48c0edb2466aa4b27d287a59c30`)と、表の元の UCD 17.0.0(Unicode License v3)を足した。表と `GraphemeState` の写しは、MIT License の「the Software のかなりの部分(substantial portions)」にあたりうるためである。#195 で写した `consumeANSI` の状態機械も、同じ項に書いた。

### Bun を更新したときの作り直し

Bun の版を上げたら(`.github/workflows/rust.yml` の `BUN_VERSION`)、新しい tag の次のファイルを読み、Rust の写しを直す。

1. `src/jsc/bindings/stringWidthTables.h` を取り、下の script で `table.rs` を作り直す。script の引数の tag、commit、UCD の版は、header の先頭と GitHub の tag から取る
2. `scripts/generate-stringwidth-tables.mjs` で、byte の bit の割り当てと break class の番号(`GraphemeBreakClass`)が変わっていないかを見る。変わっていたら `width.rs` の `classify` と `Class` を直す
3. `src/jsc/bindings/stringWidth.cpp` の `computeGraphemeBreakNoControl`、`GraphemeState`、`UTF16WidthAccumulator`、`visibleUTF16Width` と、`highway_strings.cpp` の `ClassifyBulkUTF16Unit` を、前の tag との差分で読み、`width.rs` を直す
4. 下の行列の script で、`width.rs` の行列のテストの代表と期待値を作り直す。新しい Bun で値が変わった組は、PR にその組と理由を書く(決まりの関門 5)
5. 下の「確かめたこと」の網羅の比較を走らせ直し、違いが 0 件であることを PR に書く

表を作る script(`bun gen-width-table.ts <stringWidthTables.h> bun-v1.4.4 38afee6c84fcf48c0edb2466aa4b27d287a59c30 17.0.0 > rust/crates/screen/src/text/width/table.rs`)。出力はそのまま `cargo fmt --check` を通る。

```ts
// bun gen-width-table.ts <stringWidthTables.h> <tag> <commit> <UCD version> > rust/crates/screen/src/text/width/table.rs
const [path, tag, commit, ucd] = process.argv.slice(2);
const header = await Bun.file(path).text();
const sha256 = new Bun.CryptoHasher("sha256").update(header).digest("hex");
const array = (name: string) =>
  header.match(new RegExp(`${name}\\[\\d+\\] = \\{([^}]*)\\}`))![1].split(",").map((s) => s.trim()).filter(Boolean).map(Number);
const [stage1, stage2, stage3] = ["kGraphemeBreakStage1", "kGraphemeBreakStage2", "kGraphemeBreakStage3"].map(array);
const runs: [number, number][] = [];
for (let cp = 0; cp <= 0x10ffff; cp++) {
  const packed = stage3[stage2[stage1[cp >> 8] + (cp & 0xff)]];
  if (runs.length === 0 || runs[runs.length - 1][1] !== packed) runs.push([cp, packed]);
}
const hex = (n: number, width: number) => "0x" + n.toString(16).toUpperCase().padStart(width, "0");
console.log(`//! Bun's byte for every code point, as runs of code points that share one. Bun generated its table
//! from the Unicode ${ucd} Character Database; this file is generated from Bun's
//! src/jsc/bindings/stringWidthTables.h of the tag \`${tag}\` (commit
//! ${commit}, sha256
//! ${sha256}) by the script in
//! docs/rust-migration/adr/0218-bun-string-width.md. Do not edit it by hand.

/// The first code point of each run, in ascending order, and the byte the run shares, which
/// \`classify\` in width.rs reads.
static RUNS: [(u32, u8); ${runs.length}] = [
${runs.map(([cp, packed]) => `    (${hex(cp, 5)}, ${hex(packed, 2)}),`).join("\n")}
];

/// Bun's byte for \`c\` (\`fusedClassify\`).
pub(super) fn packed(c: char) -> u8 {
    let run = RUNS.partition_point(|&(first, _)| first <= u32::from(c));
    RUNS[run - 1].1
}`);
```

行列の代表と期待値を作る script(`bun matrix.ts <stringWidthTables.h>`。出力の 2 つの `const` を、`width.rs` のテストに貼る)。

```ts
// bun matrix.ts <stringWidthTables.h>: the representatives and Bun.stringWidth of every pair of them, as Rust.
const header = await Bun.file(process.argv[2]).text();
const array = (name: string) =>
  header.match(new RegExp(`${name}\\[\\d+\\] = \\{([^}]*)\\}`))![1].split(",").map((s) => s.trim()).filter(Boolean).map(Number);
const [s1, s2, s3] = ["kGraphemeBreakStage1", "kGraphemeBreakStage2", "kGraphemeBreakStage3"].map(array);
const packed = (cp: number) => s3[s2[s1[cp >> 8] + (cp & 0xff)]];
// ClassifyBulkUTF16Unit of highway_strings.cpp, and the ASCII runs of addRun
const bulk = (u: number) =>
  u <= 0x7f || (u >= 0xa0 && u <= 0x2ff && u !== 0xa9 && u !== 0xad && u !== 0xae) || (u >= 0x370 && u <= 0x482) || (u >= 0x48a && u <= 0x52f) ||
  (u >= 0x3041 && u <= 0x3096) || (u >= 0x309b && u <= 0x30ff) || (u >= 0x3400 && u <= 0x4dbf) || (u >= 0x4e00 && u <= 0x9fff) ||
  (u >= 0xac00 && u <= 0xd7a3) || (u >= 0xff01 && u <= 0xff60);
const reps: number[] = [];
const seen = new Set<string>();
for (let cp = 0; cp <= 0x10ffff; cp++) {
  if (cp >= 0xd800 && cp <= 0xdfff) continue;
  const key = `${packed(cp)} ${bulk(cp)}`;
  if (!seen.has(key)) { seen.add(key); reps.push(cp); }
}
for (const cp of [0xa9, 0xae, 0x20e3, 0xfe0e, 0xfe0f]) if (!reps.includes(cp)) reps.push(cp);
const rows = reps.map((a) => reps.map((b) => Bun.stringWidth(String.fromCodePoint(a, b))).join(""));
const hex = (cp: number) => `'\\u{${cp.toString(16)}}'`;
console.log(`    const REPRESENTATIVES: [char; ${reps.length}] = [${reps.map(hex).join(", ")}];`);
console.log(`    const PAIR_WIDTHS: [&str; ${reps.length}] = [\n${rows.map((r) => `        "${r}",`).join("\n")}\n    ];`);
console.error(reps.length, "representatives,", seen.size, "classes");
```

## 検討した代わり

- 3 段の配列をそのまま写す: header を文字の置換だけで写せるが、上の「表の形」の理由で取らなかった
- 一般カテゴリを引ける crate を足す(Issue の候補 2): 依存を足す Issue と ADR が要る。Bun の grapheme の決まり(まとめて数える文字の前で切ること、`GraphemeState::width` の決まり)は crate では得られず、どのみち写す必要がある
- 合わせない(Issue の候補 3): プレビューの枠を、Mc の文字を含む選択肢から切り離せない
- テストのために screen の公開の口に関数を足し、`tests/width.rs` から確かめる: ADR `0192-phase-2-split` が決めた公開の口に、core から呼べる関数が増える
- Bun で数えた 110 万の値を fixture にする: 同じ header から Bun が数えた値で、表をもう 1 つ持つのに近い。Bun を更新するたびに作り直すことになる。表の写しは「script で作り直して差分が空」で、決まりは 2 文字の組の行列で確かめる
- `text.rs` に幅の処理をすべて置き、表を `src/width_table.rs`(`lib.rs` に `mod width_table;`)に置く: 表を引く関数が crate 全体に見え、byte の bit の意味を crate のどこからでも読める。`text.rs` は 676 行から 1,100 行に増え、#206(V)が書く `text.rs` の差分も大きくなる

## 依存

なし(unicode-width 0.2.3 を外す。足す crate はない)。

## 結果

- `string_width` は、エスケープシーケンスを除いた Bun 1.4.4 の `Bun.stringWidth`(ambiguous を狭い幅とする既定の設定)と、確かめた範囲(下の「確かめたこと」)のすべての文字列で同じ値を返す
- `grapheme_width` はなくなった。#206(V)が外す `#[allow(dead_code)]` は、`string_width` と `graphemes` のものだけになる
- `text.rs` は `text.rs` と `text/width.rs`、`text/width/table.rs` に分かれた。#206(V)の書くパスの `screen/src/text.rs` は、`screen/src/text/` も含めて読む
- Bun の版を上げるときは、上の「Bun を更新したときの作り直し」に従う

## 確かめたこと

- 変更の前に、#218 の文字列のテストが失敗することを見た: `cargo test --locked -p herdr-fleet-screen --lib counts_marks` が、`"का"` の assert で失敗した(Rust の値が 2、期待値が 1)。変更のあとは通る
- 網羅の比較(コミットしない): Bun 1.4.4 で、次の 5,587,688 の文字列の `Bun.stringWidth` を数え、同じ文字列の Rust の `string_width` と比べた。違いは 0 件だった
  - すべての scalar value(1,112,064 個)の、1 文字、同じ文字を 2 つ、その文字のあとに `a`、`a` のあとにその文字
  - 代表の 94 文字(byte ごとに code point の順で最初の 2 文字と、名前を挙げた文字。U+0600、U+0915、U+094D、ハングルの字母、regional indicator、肌の色、keycap、VS15・VS16、ZWJ、ESC、U+009B など)の、2 文字と 3 文字のすべての組
  - 代表の文字を 1〜8 文字並べ、ときどき `ESC [ 3 1 m` をはさんだ 300,000 の文字列(線形合同法の乱数、種は 218)
  - 幅の和が 1023 の前後になる、ハングルの初声の字母の 511〜600 文字の並び
- 比較が違いを見つけられることも確かめた: `push` のまとめて数える文字の判定を ASCII だけにすると 134 件、和の 1023 の飽和を外すと 6 件の違いが出た。まとめて数える文字のあとで break の状態を戻す処理を外しても、違いは 0 件だった(まとめて数える文字の break class が、次の判定で状態を既定に戻すため)。この処理は Bun のとおりに残した
- 表を作る script を同じ header で走らせ直すと、`table.rs` と 1 byte も違わない(`cmp` で確かめた)
- `cargo fmt --check`、`cargo clippy --locked --workspace --all-targets -- -D warnings`、`cargo test --locked --workspace` が通った。`cargo test --locked -p herdr-fleet-screen` は 69 件(単体 43、`checks` 9、`claude` 1、`codex` 3、`fallback` 1、`pi_omp` 12)で、変更の前は 65 件(単体 39)だった。画面の corpus の件と期待値は変えていない

網羅の比較の手順: Bun 側は下の script(`bun corpus.ts <stringWidthTables.h> corpus.tsv`。`HERDR_*` を外して実行した)が、1 行に code point の 16 進と `Bun.stringWidth` の値を書く。Rust 側は、`text.rs` の末尾に一時的に下のテストを足し、`WIDTH_CORPUS=corpus.tsv cargo test --release --locked -p herdr-fleet-screen --lib scratch_differential -- --ignored --nocapture` で走らせた。

```ts
// Writes `<code points in hex, space separated>\t<Bun.stringWidth>` lines.
const header = await Bun.file(process.argv[2]).text();
const array = (name: string) =>
  header.match(new RegExp(`${name}\\[\\d+\\] = \\{([^}]*)\\}`))![1].split(",").map((s) => s.trim()).filter(Boolean).map(Number);
const [s1, s2, s3] = ["kGraphemeBreakStage1", "kGraphemeBreakStage2", "kGraphemeBreakStage3"].map(array);
const packed = (cp: number) => s3[s2[s1[cp >> 8] + (cp & 0xff)]];
const scalar = (cp: number) => cp < 0xd800 || cp > 0xdfff;
const out: string[] = [];
const emit = (cps: number[]) => out.push(`${cps.map((c) => c.toString(16)).join(" ")}\t${Bun.stringWidth(String.fromCodePoint(...cps))}`);
let singles = 0, doubles = 0;
for (let cp = 0; cp <= 0x10ffff; cp++) if (scalar(cp)) { emit([cp]); emit([cp, cp]); emit([cp, 0x61]); emit([0x61, cp]); singles++; }
// representatives: the first two code points of each packed byte, and the characters Bun names
const reps = new Set<number>([0x20, 0x41, 0x7e, 0x09, 0x1b, 0x9b, 0x85, 0xa9, 0xae, 0xad, 0xe9, 0x3b1, 0x483, 0x200d, 0x200c, 0xfe0e, 0xfe0f, 0x20e3,
  0x1f1e6, 0x1f1ef, 0x1f1f5, 0x1f3fb, 0x1f3ff, 0x1f44d, 0x1f600, 0x2764, 0x263a, 0x23, 0x31, 0x600, 0x915, 0x93e, 0x94d, 0x937, 0x1100, 0x1161, 0x11a8, 0xac00, 0xac01,
  0x4e00, 0x3042, 0xff21, 0x301, 0xe0020, 0xe007f, 0x1f9d1, 0x2640, 0x5b, 0x6d]);
const seen = new Map<number, number>();
for (let cp = 0; cp <= 0x10ffff; cp++) if (scalar(cp)) { const p = packed(cp); const n = seen.get(p) ?? 0; if (n < 2) { reps.add(cp); seen.set(p, n + 1); } }
const r = [...reps];
for (const a of r) for (const b of r) { emit([a, b]); for (const c of r) emit([a, b, c]); }
// random sequences over the representatives, with escapes between
let seed = 218;
const rand = (n: number) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
for (let i = 0; i < 300000; i++) {
  const len = 1 + rand(8);
  const cps: number[] = [];
  for (let k = 0; k < len; k++) { if (rand(10) === 0) cps.push(0x1b, 0x5b, 0x33, 0x31, 0x6d); else cps.push(r[rand(r.length)]); }
  emit(cps);
}
// long graphemes around the saturation at 1023
for (const n of [511, 512, 513, 600]) { emit(Array(n).fill(0x1100)); emit([...Array(n).fill(0x1100), 0xfe0f]); emit([0x1f44d, ...Array(n).fill(0x1100)]); }
await Bun.write(process.argv[3], out.join("\n") + "\n");
console.log("singles", singles, "reps", r.length, "lines", out.length);
```

```rust
#[cfg(test)]
mod scratch_differential {
    #[test]
    #[ignore]
    fn against_bun() {
        let path = std::env::var("WIDTH_CORPUS").unwrap();
        let text = std::fs::read_to_string(path).unwrap();
        let (mut total, mut wrong) = (0, 0);
        for line in text.lines() {
            let (cps, width) = line.split_once('\t').unwrap();
            let s: String = cps.split(' ').map(|h| char::from_u32(u32::from_str_radix(h, 16).unwrap()).unwrap()).collect();
            let width: usize = width.parse().unwrap();
            total += 1;
            let got = super::string_width(&s);
            if got != width {
                wrong += 1;
                if wrong <= 30 { eprintln!("{cps}: bun {width} rust {got}"); }
            }
        }
        eprintln!("total {total} wrong {wrong}");
        assert_eq!(wrong, 0);
    }
}
```
