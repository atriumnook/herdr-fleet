# 段階 2 の解析の crate の外部 crate と、TypeScript と Rust の違いの扱い

- 状態: 採用
- 決めた日: 2026-11-08
- Issue: #193

## 状況

ADR `0192-phase-2-split` は、段階 2 の外部 crate を P0(#193)がまとめて足すと決め、crate ごとの一覧を挙げた(「外部 crate」)。計画(`docs/rust-migration/plan.md` の「守ること」)は、crate を足す前に、ライセンス、保守の状況、`build.rs` が何を実行するかを読み、ADR に書くことを求めている。

同じ ADR は、段階 2 の Issue ごとに違う訳し方をしないため、TypeScript と Rust の振る舞いの違いの扱いを P0 の ADR に書くことも求めた。正規表現、UTF-16 の長さ、`JSON.stringify` と serde_json、寛容な base64 の復号、`Bun.stringWidth` と `Intl.Segmenter` の 5 つである。段階 2 のほかの Issue(S1〜S5、T1〜T6)は、この ADR の決まりに従う。

段階 2 で移す TypeScript のファイルは、`server/prompt.ts`、`server/fleet/adapters.ts`、`server/conversation.ts`、`server/transcript-records.ts`、`server/tool-output.ts`、`server/skill-activity.ts`、`server/pi-tree.ts`、`server/opencode-session.ts`、`server/opencode-messages.ts`、`server/conversation-metadata.ts`、`server/conversation-errors.ts`、`server/codex.ts`、`server/codex-images.ts`、`shared/patch.ts` である(`docs/rust-migration/architecture/2026-11-08-parsing-crates-review.html`)。下の行番号は `rust` の `82f36ce` のもの。

protocol の型の形と、2 つ以上の crate が使う JavaScript の文字列の関数(`protocol::js`)は、ADR `0193-protocol-types` に書いた。

## 決定

### 足す crate

`rust/Cargo.toml` の `[workspace.dependencies]` に版と feature を 1 回だけ書き、各 crate は `<名前>.workspace = true` で依存する。

| crate | 版 | feature | 使う crate | 使う箇所 |
|---|---|---|---|---|
| serde | 1.0.229 | `derive` | protocol、screen、transcript | 型の読み書き |
| serde_json | 1.0.154 | `float_roundtrip`、`preserve_order` | protocol、screen、transcript | protocol: `patch_text` の JSON の文字列のリテラル(`shared/patch.ts:19`)。screen: content id の入力の符号化、`AnswerStep`。transcript: 記録の読み取りと `JSON.stringify(input, null, 2)` |
| regex | 1.13.1 | 既定(`std`、`perf`、`unicode`) | protocol、screen、transcript | TypeScript の正規表現の書き換え |
| sha2 | 0.11.1 | なし(`default-features = false`) | screen、transcript | screen: カードの content id。transcript: Codex の画像の ref(`server/codex-images.ts:36`) |
| unicode-width | 0.2.3 | 既定 | screen | `Bun.stringWidth`(`server/prompt.ts:433, 441`) |
| unicode-segmentation | 1.13.3 | 既定 | screen | `Intl.Segmenter` の grapheme(`server/prompt.ts:428`) |
| unicode-normalization | 0.1.26 | 既定(`std`) | screen | NFKC(`server/prompt.ts:383`) |
| base64 | 0.23.1 | 既定 | transcript | OpenCode のカーソル(`server/opencode-session.ts:300`)、画像のデータの復号 |

- serde_json の `float_roundtrip` は、小数を正しく丸めて読む(JavaScript の `JSON.parse` と同じ f64 になる)。これがないと、serde_json は `0.9999999999999999` を `1.0` と読み、`Number.isInteger` が偽になる答えの番号を、screen が整数として受け付けてしまう。依存は増えない
- serde_json の `preserve_order` は、JSON のオブジェクトのキーを読んだ順に保つ。`JSON.stringify(input, null, 2)` の結果が会話ログの corpus の期待値に 768 件あり、キーの順序が答えに出る(ADR `0192-phase-2-split`)。feature は workspace の中で合わさり、protocol と screen の serde_json も同じ feature で build される
- sha2 の既定の feature は `alloc` と `oid`(ハッシュのアルゴリズムの OID。依存 const-oid を引き込む)で、どちらも使わない。外すと const-oid が依存から消える。`Sha256::digest` は feature なしで使える
- regex の既定の feature のうち `unicode` は、`\p{L}`(`server/prompt.ts:383` の `comparable`)と、ASCII でない文字への照合に要る
- 足さないもの(ADR `0192-phase-2-split` のとおり): 乱数の crate、block_on、tempfile と filetime。dev-dependency だけの crate も足さない。protocol のテストは、通常の依存の serde_json を使う

### TypeScript と Rust の違いの扱い

#### 正規表現

regex crate は、先読み・後読み・後方参照を持たない(`x(?=y)` は `look-around ... is not supported` で断られる)。また、文字クラスの既定が Unicode で、JavaScript と範囲が違う。TypeScript の正規表現は次のように書き換える。

- `\s` と `\S`: `protocol::js::WHITESPACE` と、その否定 `[^…]` を使う。regex の `\s` は U+0085 を含み U+FEFF を含まないので使わない。ほかの文字と組み合わせるときは、regex の入れ子の文字クラスで書く(`[^` + `js::WHITESPACE` + `→❯➜]`)
- `.`(`s` フラグなし): `[^\n\r\u{2028}\u{2029}]`(`js::LINE_TERMINATOR` の否定)と書く。regex の `.` は `\r`、U+2028、U+2029 にも当たる。`s` フラグの `.` と `[\s\S]` は `(?s:.)` と書く。`u` フラグのない JavaScript の `.` は UTF-16 の code unit 1 つに当たる(下の「回数の指定」)
- 回数の指定(`{n}`、`{n,m}`): `u` フラグのない JavaScript では、`.`、`\S`、否定の文字クラスのように BMP の外の文字(絵文字など)に当たりうる部分の回数を、UTF-16 の code unit で数える。regex は code point で数えるので、BMP の外の文字 1 つが JavaScript では 2 回、regex では 1 回になる。そのような部分の回数の指定は、上限のない繰り返しの group にし、group の `js::utf16_len` が範囲に入るかを Rust のコードで確かめる。ASCII だけの文字クラス(`[0-9a-f]{64}`、`[─━]{8,}` のような BMP の中の文字だけのクラス)は、どちらで数えても同じなので、そのまま書く。段階 2 で移すファイルで当たるのは `server/prompt.ts:1246` の `/:\s*\S{0,3}$/`(S4)だけで、次のように書き換える。文字列の最後の `:` より後ろが `^` + `js::WHITESPACE` + `*(` + 空白でない文字 `*)$` に当たり、group の `js::utf16_len` が 3 以下のときに当たりとする。最後の `:` だけを見ればよいのは、前の `:` で当たるなら、その `:` より後ろには空白がなく、最後の `:` でも当たるためである。`Select: 😀😀` は、JavaScript では当たらない(空白でない code unit が 4 つ)が、regex の `\S{0,3}` では当たる(code point が 2 つ)。`:`、空白、`a`、`😀` を 0〜7 個並べた 21,845 の文字列で、この書き換えは JavaScript とすべて同じ答えになり、regex の `^.*:\s*\S{0,3}$` は 1,237 の文字列で違った
- `\b`、`\B`、`\w`、`\d`: JavaScript では ASCII だけを見る。`(?-u:\b)`、`(?-u:\B)`、`[0-9A-Za-z_]`、`[0-9]` と書く。regex の `\b` は Unicode の単語の文字を見るので、`/\bto answer$/` は `éto answer` に当たるが、regex の `\bto answer$` は当たらない。`(?-u:\b)to answer$` は JavaScript と同じく当たる
- `m` フラグ: パターンの本体が行末を越えない(`.` と、行末を含まない文字クラスだけの)ときは、`js::is_line_terminator` で行に分け、各行に `m` なしで照合する(`patch_files` がこの形)。越えうるときは `(?mR)` と書く。`(?mR)` は U+2028 と U+2029 を行末と見ず、`\r\n` の間では `$` が当たらない点が JavaScript と違う。`(?mR)` で書き換えた Issue は、`\r\n` を含む件をテストに足す
- `i` フラグ: regex の `(?i)` は Unicode の単純な大文字小文字の対応を使い、`(?i)k` は U+212A(KELVIN SIGN)に、`(?i)s` は U+017F(LATIN SMALL LETTER LONG S)に当たる。`u` フラグのない JavaScript は、ASCII でない文字を ASCII の文字に対応させないので、どちらにも当たらない(Bun 1.4.4 で確かめた)。段階 2 では、この 2 文字を JavaScript に合わせない。`fixtures/` のどのファイルにも、この 2 文字はない(grep で 0 件)
- 先読みは、`server/prompt.ts` の 3 か所を次のように書き換える
  - 377 行 `/^›\s(?!\d+\.)/.test(line)`(否定の先読みがパターンの末尾にある): `^›` + `js::WHITESPACE` で照合し、当たった位置より後ろの文字列が `^[0-9]+\.` に当たらないことを確かめる。末尾の否定の先読みは、手前の部分で照合し、当たった位置から先読みのパターンを `^` 付きで照合して、結果を反転する
  - 540 行 `/([☐☒☑✔])\s+(.+?)(?=\s{2,}|\s*$)/g` の `matchAll`(肯定の先読み): 先読みの部分を消費する形 `([☐☒☑✔])` + `js::WHITESPACE` + `+(.+?)(?:` + 2 個以上の空白 `|` 0 個以上の空白 `$)` に書き換える。消費する文字は空白だけで、次の一致は `[☐☒☑✔]` で始まるので、消費しても見つかる一致は変わらない。肯定の先読みは、消費する文字が次の一致の始まりになりえないときだけ、この形にしてよい
  - 941 行 `/^ (?![\u2192\u276f\u279c])\S/`(1 文字の否定の先読みのあとに 1 文字のクラス): 2 つのクラスの共通部分 `^ [^` + `js::WHITESPACE` + `\u{2192}\u{276f}\u{279c}]` に書き換える
- 後方参照: `server/codex.ts:24` の `/^<(environment_context|permissions instructions|turn_aborted|subagent_notification)>[\s\S]*<\/\1>$/`(T3)は、選択肢ごとに開きと閉じを書いた選択に展開する(`^(?:<environment_context>(?s:.)*</environment_context>|<permissions instructions>(?s:.)*</permissions instructions>|…)$`)
- sticky(`y` フラグ): `server/codex.ts:90` の `/[ \t]*>[ \t]?/y` を `lastIndex` で進める繰り返し(T3)は、`^[ \t]*>[ \t]?` を `&source[offset..]` に照合し、当たった長さだけ `offset` を進める
- 置き換え: TypeScript の `replace` は、文字列のパターンでは最初の 1 つだけ、`g` フラグの正規表現ではすべてを置き換える。Rust では `replacen(…, 1)` と `Regex::replace` が最初の 1 つ、`str::replace` と `Regex::replace_all` がすべてである。置き換えの文字列の `$1` のあとに英数字が続くときは、regex が `$1a` を名前 `1a` の group と読むので `${1}a` と書く
- 行に分ける: `split(/\r?\n/)` は、`str::split('\n')` のあとで、最後を除く各行の末尾の `\r` を 1 つ除く。最後の行は `\n` で終わっていないので、末尾の `\r` を残す(`"abc\r".split(/\r?\n/)` は `["abc\r"]`、`"a\r\nb\r"` は `["a", "b\r"]`)。`str::lines` は、最後の行の `\r` も除き、末尾の改行のあとの空の行を返さない点が違う
- 段階 2 の外の先読み: `server/codex.ts:391` と `server/claude-store.ts:52`(ps の行から環境変数を読む)と `server/codex.ts:1258`(`shortThreadFromProcess`)は core の部分で、段階 4 の Issue が移す。前の 2 つは、先読みの `\s` が次の一致の始まりになるので、上の消費する形にできない

#### UTF-16 の長さ

TypeScript の文字列の `.length`、`slice`、`substring` の位置は、UTF-16 の code unit で数える。Rust では `protocol::js::utf16_len` と `protocol::js::cut_utf16` を使う。`for … of`、`[...text]`、`new Set(text)` は code point ごとに回るので、Rust の `chars()` と同じである。

- 段階 2 で数える箇所: カードの `body` の 12,000(`server/prompt.ts:211`)、ツールの出力の 4,000 と 16,000 と `output_size`(`server/tool-output.ts:14-20`。`output_size` は corpus の期待値に出る)、notice の上限(`server/conversation.ts:122`、`server/opencode-messages.ts:148`)、ツールの出力の上限(`server/conversation.ts:1140, 1244`)、ツールの要約の 120(`server/transcript-records.ts:130, 234`、`server/codex.ts:308`、`server/opencode-messages.ts:45`)、skill の名前とパスの長さの上限(`server/skill-activity.ts:5, 9, 31`)、`server/codex.ts:181` の 2,000、`server/prompt.ts:389` の 24
- `slice` がサロゲートの対の途中で切るとき、JavaScript は対の前半だけを残し、`JSON.stringify` はそれを `\ud83d` のように書く。Rust の `String` はそれを持てないので、`cut_utf16` は対の前で切る。その場合、切ったあとの文字列は TypeScript より 1 code unit 短い。`output_size` は切る前の全体の長さなので、TypeScript と同じ値になる。会話ログの corpus の期待値に、対のないサロゲートのエスケープは 1 件もない(grep で 0 件)

#### `JSON.stringify` と serde_json

- `JSON.parse` が読み、serde_json が断る JSON: 対のないサロゲートのエスケープ(`"\ud800x"`。`JSON.parse` は対のない前半を持つ文字列にし、serde_json は `unexpected end of hex escape` で断る)と、f64 の範囲を超える数(`1e400`。`JSON.parse` は `Infinity` にし、`JSON.stringify` はそれを `null` と書き、serde_json は `number out of range` で断る)の 2 つ。Rust は、そのような JSON を読めない値として扱う。transcript の記録は、壊れた行と同じく飛ばす(TypeScript は記録を読み、ほかの項目を表示する)。`patch_text` は `None` を返す。会話ログの corpus には、どちらも 1 件もない(対のないサロゲートのエスケープは grep で 0 件、f64 を超える数は python の `json` で全 5,049 の記録を読んで 0 件)。実際の transcript で見つかったときは、記録の読み手を変える Issue を開く
- 大きな整数: serde_json は ±2^63 までの整数を正確に読むが、JavaScript は 2^53 を超える整数を f64 に丸める(`JSON.stringify(2**53+1)` は `9007199254740992`)。JavaScript と同じ値を書くときは、整数を一度 f64 にしてから書く
- 数の書き方: `JSON.stringify` は ECMAScript の Number::toString で数を書く。整数の値の f64 は小数点なし(`1.0` は `1`、`1e3` は `1000`、`-0` は `0`)、絶対値が 1e21 以上と 1e-6 未満は指数の形(`1e+21`、`1e-7`)である。serde_json は f64 の `1.0` を `1.0`、`1e3` を `1000.0`、`-0` を `-0.0` と書く(指数の形は `1e+21`、`1e-7` で同じ)。そのため T1 は、transcript の `JSON.stringify(x, null, 2)` を、`serde_json::Value` をたどる自前の writer で書く。決まりは次のとおり
  - キーの順序: JavaScript のオブジェクトは、配列の添字の形のキー(0 から 4294967294 までの整数を、先頭に 0 を付けずに 10 進で書いたもの)を数の小さい順に先に並べ、残りのキーを足した順に並べる。writer も、各オブジェクトでこの順に書く(入れ子のオブジェクトにも当てる)。それ以外のキーの順序は、serde_json の `preserve_order` が読んだ順に保つ。Bun で `JSON.stringify(JSON.parse('{"b":0,"10":10,"2":2,"a":1,"4294967295":5,"4294967294":4,"01":6}'))` は `{"2":2,"10":10,"4294967294":4,"b":0,"a":1,"4294967295":5,"01":6}`
  - 字下げと区切りは serde_json の pretty と同じ(2 桁の空白、`": "`、空の配列は `[]`、空のオブジェクトは `{}`)。文字列のエスケープも serde_json と同じ(`\b`、`\f`、`\n`、`\r`、`\t`、ほかの U+0020 未満は小文字の 16 進の `\u00XX`、DEL と U+2028 と ASCII でない文字はそのまま)
  - 数は Number::toString の形にする。桁の列は、最短で往復する桁数 k を Rust の `format!("{:e}", x)` で求め、`format!("{:.*e}", k - 1, x)`(正しく丸めた k 桁)が読み戻して x になればその桁、ならなければ `{:e}` の桁を使う。ECMAScript は、最短の桁数で往復する桁の列が 2 つ以上あるとき x に最も近いものを選ぶが、`{:e}` はそうとは限らない(`652282746268236.2` を `{:e}` は `6.522827462682363e14` と書き、Bun は `652282746268236.2` と書く)。桁の列を Number::toString の配置(小数点の位置、`e+`・`e-` の指数)で書く。この決まりを scratchpad の Rust で書き、Bun の `JSON.stringify` と 120,014 の数(ランダムなビット列の有限の f64 が 100,000、有効数字の少ない数が 20,000、境界の値が 14)で比べ、すべて同じ文字列になった
- screen の content id の入力(`server/prompt.ts:1359` の `JSON.stringify({card, screen, working})` の sha256): id の値は corpus の期待値に出ず、同じ id になる件だけが比べられる(`sameIdAs`)。ADR `0192-phase-2-split` は id の長さも変える。そのため serde_json の出力をそのまま使い、TypeScript と同じバイト列にはしない。同じ入力から同じ id になること(決定的であること)だけを守る
- OpenCode のカーソル(`server/opencode-session.ts:300`): `{"id":…,"order":"desc","direction":"next"}` の compact な JSON を base64url(`=` の埋めなし)にしたもので、記録した応答 `api.json` のキーと同じバイト列でなければならない。値は文字列だけなので、serde_json の compact な出力は `JSON.stringify` と同じバイト列になる。base64 crate の `URL_SAFE_NO_PAD` で符号化する。Node の `toString("base64url")` も埋めない(Bun で `Buffer.from("ab").toString("base64url")` が `YWI`)

#### 寛容な base64 の復号

TypeScript の `Buffer.from(s, "base64")`(`server/conversation.ts:1122, 1216` の Claude の画像、`server/opencode-session.ts:135` の OpenCode のファイル、`server/codex-images.ts:58` の Codex の画像)は、壊れた入力でも失敗せずにバイト列を返す。Bun 1.4.4 で確かめた振る舞いは次のとおりで、T1 は同じ規則で復号する。

- 標準の文字(`+` と `/`)と URL 用の文字(`-` と `_`)の両方を読む
- 2 つの文字の集合のどちらにもない文字(空白、改行、`*`、`#` など)は飛ばす
- 最初の `=` で止まり、そのあとは読まない
- 最後に 1 文字だけ余ったら捨てる。余ったビットは無視する
- 上のどれよりも先に、文字列の UTF-16 の code unit をそれぞれ下位 8 ビットのバイトにする(Node の `latin1` と同じ)。そのため ASCII でない文字は、飛ばされずに別の ASCII の文字として読まれうる。`Ł`(U+0141)は `A`(0x41)、`😀` などの絵文字の前半のサロゲート(U+D83D)は `=`(0x3D)になる

Rust の書き方: 文字列を UTF-16 の code unit ごとに下位 8 ビットのバイトにし、そのバイト列を最初の `=` の手前までにし、`-` を `+` に、`_` を `/` に置き換え、標準の文字の集合にないバイトを除く。残りの長さを 4 で割って 1 余れば最後の 1 文字を除き、base64 crate の `GeneralPurpose`(`alphabet::STANDARD`、`DecodePaddingMode::Indifferent`、`with_decode_allow_trailing_bits(true)`)で復号する。base64 crate の既定の engine は、長さが 4 で割って 1 余る入力を `Invalid input length` で断るので、前の手順が要る。T1 のテストの期待値は、次の Bun の答えから取る。

| 入力 | Bun 1.4.4 の `Buffer.from(入力, "base64")` |
|---|---|
| `aGVsbG8=`、`aGVsbG8`、`aGVs bG8=`、`aGVs\nbG8=`、`aGVsbG8=extra`、`aGV*sbG8`、`aGVsbG9` | `[104,101,108,108,111]`(`hello`) |
| `aGVsbG8-_w`、`aGVsbG8+/w` | `[104,101,108,108,111,62,255]` |
| `aGVsbG8xY` | `[104,101,108,108,111,49]` |
| `aGVsbG8xYQ` | `[104,101,108,108,111,49,97]` |
| `aGVs=bG8=` | `[104,101,108]` |
| `=aGVs`、空の文字列、`####` | `[]` |
| `aG💩VsbG8=` | `[104]`(💩 の前半のサロゲートが `=` になる) |
| `aGŁVsbG8=` | `[104,96,21,177,177,188]`(`aGAVsbG8=` と同じ) |
| `aGé VsbG8=` | `[104,101,108,108,111]`(é は 0xE9 になり、文字の集合にないので飛ばす) |

#### 文字の幅と grapheme

画面の corpus の `screen.txt` 347 件に出るすべての文字で、unicode-width と `Bun.stringWidth`、unicode-segmentation と `Intl.Segmenter` を比べた(方法は「確かめたこと」)。

- grapheme の区切り: 998 行(各ファイルの行と、その行から `server/prompt.ts:6` の `ANSI_RE` を除いた行の、重複を除いたもの)の 53,534 個の grapheme で、`graphemes(true)` の区切りは `Intl.Segmenter` とすべて一致した。合わせる処理は要らない
- 1 文字の幅: 349 種類の code point のうち、違うのは制御文字の 4 つ(U+0007、U+000A、U+000D、U+001B)だけだった。`Bun.stringWidth` は 0、unicode-width の `char::width()` は `None`、`str::width()` は 1 を返す
- grapheme ごとの幅(`server/prompt.ts:428` の `indexAtColumn` の数え方): 違うのは 160 個で、すべて ESC(147 個)か BEL(13 個)だけの grapheme だった
- 行全体の幅(`server/prompt.ts:441` の数え方): 違うのは 46 行で、すべて ESC を含む行だった。`Bun.stringWidth` はエスケープシーケンスを数えない。`ANSI_RE` が除くのは CSI だけなので、OSC 8 のハイパーリンク(`ESC ] 8 ; ; … BEL`)は、TypeScript でも `ANSI_RE` を通したあとの行に残る

S1 は `text.rs` に次の 2 つを置き、S2〜S4 はそれを使う。

- grapheme の幅: 制御文字(U+0000〜U+001F、U+007F、U+0080〜U+009F)だけからなる grapheme は 0、それ以外は unicode-width の `str::width`
- 文字列の幅: 先にエスケープシーケンスを除く。除くのは、CSI(`ESC [` か U+009B から、U+0040〜U+007E の終わりの文字まで)、OSC(`ESC ]` から、BEL か `ESC \` まで。終わりがなければ文字列の終わりまで)、ほかの `ESC` である。ほかの `ESC` は、次の文字が U+0020〜U+002F なら、その範囲の文字が続く間と、そのあとの 1 文字(どの文字でも)まで、次の文字が U+0030〜U+007E ならその 1 文字まで、それ以外なら `ESC` だけを除く。残りから制御文字を除き、unicode-width の `str::width` で数える

この規則を scratchpad の Rust で書き、上の 998 行すべてと、次の 23 の文字列で `Bun.stringWidth` と同じ値になることを確かめた。S1 のテストの期待値は、この表から取る。

| 文字列 | Bun 1.4.4 の `Bun.stringWidth` | unicode-width の `str::width` |
|---|---|---|
| `a ESC[31m b` | 2 | 7 |
| `a ESC]8;;http://x BEL b` | 2 | 16 |
| `a ESC]8;;http://x ESC\ b` | 2 | 17 |
| `a ESC b` | 1 | 3 |
| `a ESC(B b` | 2 | 5 |
| `a DEL b` | 2 | 3 |
| `a U+009B 31m b` | 2 | 6 |
| `a U+0085 b` | 2 | 3 |
| `a TAB b` | 2 | 3 |
| `a U+200B b` | 2 | 2 |
| `👨‍👩‍👧`(ZWJ でつないだ 3 人) | 2 | 2 |
| `☺ U+FE0F` | 2 | 2 |
| `e U+0301` | 1 | 1 |
| `…─○` | 3 | 3 |
| `あ` | 2 | 2 |
| `a ESC]8;;xb`(OSC の終わりがない) | 1 | 8 |
| `a ESC 😀 b` | 4 | 5 |
| `a ESC é b`(é のあとに空白) | 4 | 5 |
| `a ESC( 😀 b` | 2 | 6 |
| `a ESC ESC[31m b` | 2 | 8 |
| `a ESC SP b`(SP は空白) | 1 | 4 |
| `a ESC DEL b` | 2 | 4 |
| `a ESC`(文字列の終わり) | 1 | 2 |

表の文字列の空白は読みやすくするためのもので、実際の文字列には含まない(`a ESC[31m b` は `"a\x1b[31mb"`)。ただし `a ESC é b` の é のあとの空白と、`SP` は実際の空白である。

## 検討した代わり

- fancy-regex(先読みと後方参照を持つ regex): 段階 2 で移すファイルの先読みは 3 か所、後方参照は 1 か所で、上の書き換えで足りる。fancy-regex は backtracking の engine を足し、入力によっては照合の時間が入力の長さの指数で増える。regex は入力の長さに比例する時間で照合する
- serde_json を `preserve_order` なしで使う: オブジェクトのキーが名前の順に並び替わり、`JSON.stringify(input, null, 2)` の期待値 768 件とキーの順序が合わない
- sha2 を既定の feature のまま使う: 使わない const-oid が依存に入る
- `Bun.stringWidth` を自前の幅の表で写す: unicode-width との違いは制御文字とエスケープシーケンスだけで、上の 2 つの規則で合う
- 対のないサロゲートを U+FFFD に置き換えてから読む: Web UI は対のないサロゲートを U+FFFD として表示するので、見た目は TypeScript と同じになる。ただし corpus に件がなく、実際に出るかもわからないので、要るとわかった Issue が足す
- serde_json の `arbitrary_precision`(数を文字列のまま持つ)で `1e400` を読む: feature は workspace の中で合わさり、protocol と screen を含むすべての crate の `serde_json::Value` の数の持ち方を変える。corpus に件がないので足さない
- base64 の復号を自前で書く: 前処理だけを自前にし、復号は広く使われている base64 crate に任せる

## 依存

足した crate と、その推移的な依存のすべて(`rust/Cargo.lock` に入った 33 の package)。入手元はすべて crates.io で、版はどれも 2026-11-08 の時点での crates.io の最新の stable 版である。公開日は crates.io の API(`/api/v1/crates/<名前>/<版>`)の `created_at`。

| package | 版 | 引き込む crate | ライセンス | リポジトリ | 公開日 | `build.rs` |
|---|---|---|---|---|---|---|
| serde | 1.0.229 | (直接) | MIT OR Apache-2.0 | serde-rs/serde | 2026-07-18 | あり(下記) |
| serde_core | 1.0.229 | serde、serde_json | MIT OR Apache-2.0 | serde-rs/serde | 2026-07-18 | あり(下記) |
| serde_derive | 1.0.229 | serde(`derive`) | MIT OR Apache-2.0 | serde-rs/serde | 2026-07-18 | なし。proc macro で、コンパイルの中で `Serialize` と `Deserialize` の実装のコードを生成する |
| proc-macro2 | 1.0.107 | serde_derive | MIT OR Apache-2.0 | dtolnay/proc-macro2 | 2026-07-19 | あり(下記) |
| quote | 1.0.47 | serde_derive | MIT OR Apache-2.0 | dtolnay/quote | 2026-07-19 | あり(下記) |
| syn | 3.0.9 | serde_derive | MIT OR Apache-2.0 | dtolnay/syn | 2026-10-12 | なし |
| unicode-ident | 1.0.27 | proc-macro2、syn | (MIT OR Apache-2.0) AND Unicode-3.0 | dtolnay/unicode-ident | 2026-10-12 | なし |
| serde_json | 1.0.154 | (直接) | MIT OR Apache-2.0 | serde-rs/json | 2026-10-11 | あり(下記) |
| indexmap | 2.14.2 | serde_json(`preserve_order`) | Apache-2.0 OR MIT | indexmap-rs/indexmap | 2026-09-05 | なし |
| equivalent | 1.0.3 | indexmap | Apache-2.0 OR MIT | indexmap-rs/equivalent | 2026-10-13 | なし |
| hashbrown | 0.17.1 | indexmap | MIT OR Apache-2.0 | rust-lang/hashbrown | 2026-05-09 | なし |
| foldhash | 0.2.0 | serde_json | Zlib | orlp/foldhash | 2025-08-23 | なし |
| itoa | 1.0.18 | serde_json | MIT OR Apache-2.0 | dtolnay/itoa | 2026-03-20 | なし |
| zmij | 1.0.23 | serde_json | MIT | dtolnay/zmij | 2026-07-13 | あり(下記) |
| memchr | 2.8.3 | serde_json、regex、aho-corasick | Unlicense OR MIT | BurntSushi/memchr | 2026-07-08 | なし |
| regex | 1.13.1 | (直接) | MIT OR Apache-2.0 | rust-lang/regex | 2026-07-15 | なし |
| regex-automata | 0.4.18 | regex | MIT OR Apache-2.0 | rust-lang/regex | 2026-08-04 | なし |
| regex-syntax | 0.8.11 | regex、regex-automata | MIT OR Apache-2.0 | rust-lang/regex | 2026-06-09 | なし |
| aho-corasick | 1.1.5 | regex、regex-automata | Unlicense OR MIT | BurntSushi/aho-corasick | 2026-08-03 | なし |
| sha2 | 0.11.1 | (直接) | MIT OR Apache-2.0 | RustCrypto/hashes | 2026-10-12 | なし |
| digest | 0.11.3 | sha2 | MIT OR Apache-2.0 | RustCrypto/traits | 2026-05-03 | なし |
| crypto-common | 0.2.2 | digest | MIT OR Apache-2.0 | RustCrypto/traits | 2026-05-19 | なし |
| block-buffer | 0.12.1 | digest | MIT OR Apache-2.0 | RustCrypto/utils | 2026-06-11 | なし |
| hybrid-array | 0.4.15 | block-buffer、crypto-common | MIT OR Apache-2.0 | RustCrypto/hybrid-array | 2026-09-08 | なし |
| typenum | 1.20.1 | hybrid-array | MIT OR Apache-2.0 | paholg/typenum | 2026-05-29 | なし |
| cfg-if | 1.0.5 | sha2 | MIT OR Apache-2.0 | rust-lang/cfg-if | 2026-09-16 | なし |
| cpufeatures | 0.3.1 | sha2 | MIT OR Apache-2.0 | RustCrypto/utils | 2026-08-26 | なし |
| libc | 0.2.191 | cpufeatures(aarch64 と loongarch64 の Linux、aarch64 の Android と Apple の target だけ) | MIT OR Apache-2.0 | rust-lang/libc | 2026-10-16 | あり(下記) |
| unicode-width | 0.2.3 | (直接) | MIT OR Apache-2.0 | unicode-rs/unicode-width | 2026-10-28 | なし |
| unicode-segmentation | 1.13.3 | (直接) | MIT OR Apache-2.0 | unicode-rs/unicode-segmentation | 2026-06-01 | なし |
| unicode-normalization | 0.1.26 | (直接) | (MIT OR Apache-2.0) AND Unicode-3.0 | unicode-rs/unicode-normalization | 2026-10-16 | なし |
| tinyvec | 1.13.3 | unicode-normalization | Zlib OR Apache-2.0 OR MIT | Lokathor/tinyvec | 2026-09-13 | なし |
| base64 | 0.23.1 | (直接) | MIT OR Apache-2.0 | marshallpierce/rust-base64 | 2026-08-04 | なし |

- ライセンス: どれも workspace の MIT と組み合わせて配布できる許諾型のライセンスである。Unicode-3.0 は、unicode-ident と unicode-normalization が持つ Unicode の文字のデータの表に当たる
- 保守の状況: どの package も、使う版が crates.io の最新の stable 版で、33 のうち 32 は 2026 年に版を出している。foldhash は 2025-08-23 の 0.2.0 が最新の版である。リポジトリの持ち主は、Rust プロジェクト(rust-lang)、serde と syn の保守者(dtolnay、serde-rs)、RustCrypto、unicode-rs などで、どれも crates.io で直近 90 日に 1 億回を超えてダウンロードされている(crates.io の `recent_downloads`。最も少ない hybrid-array で 139,677,247)
- `build.rs`(`~/.cargo/registry/src/` の各 package の `build.rs` を読んだ。どれもネットワークを使わない):
  - serde、serde_core: `$RUSTC --version` を実行して rustc の minor の版を読み、版に応じて `cargo:rustc-cfg` を出す。`OUT_DIR` に、決まった文字列に patch の版を入れた `private.rs` を書く
  - serde_json: 環境変数 `CARGO_CFG_TARGET_ARCH` と `CARGO_CFG_TARGET_POINTER_WIDTH` を読み、数の解析の単位(32 か 64 ビット)の cfg を出す。何も実行しない
  - proc-macro2: `$RUSTC --version` を実行する。さらに、package に含まれる `src/probe/*.rs` を rustc(`RUSTC_WRAPPER` があればそれを通して)で `--emit=dep-info,metadata` でコンパイルし、`proc_macro_span` などの機能があるかを調べ、出力を置いた `OUT_DIR/probe` を消す。結果に応じて cfg を出す
  - quote、zmij: `$RUSTC --version` を実行し、版に応じて cfg を出す。zmij は `OPT_LEVEL` も読む
  - libc: `$RUSTC --version`(`RUSTC_WRAPPER` があればそれを通して)を実行し、target の環境変数に応じて cfg を出す。FreeBSD の target では `freebsd-version`、emscripten の target では `emcc -dumpversion` を実行する。x86_64 の Linux の build には入らない(cpufeatures が上の target でだけ依存する)

## 結果

- 段階 2 のほかの Issue は、外部 crate を足さずに作業できる。さらに要るとわかったときは、ADR `0192-phase-2-split` のとおり、依存を足す Issue を別に開いて待つ
- S1〜S5 と T1〜T6 は、TypeScript の正規表現、UTF-16 の長さ、`JSON.stringify`、base64 を、上の決まりで書き換える。上の決まりにない違いを見つけた Issue は、その扱いを自分の PR と HANDOFF の Assumptions に書く
- S1 は文字の幅の 2 つの規則を `screen/src/text.rs` に置き、テストの期待値を上の表から取る。T1 は `JSON.stringify(x, null, 2)` の writer と寛容な base64 の復号を transcript に置き、テストの期待値を上の表と Bun の答えから取る
- `i` フラグの 2 文字(U+212A、U+017F)、`cut_utf16` がサロゲートの対の前で切ること、serde_json が断る JSON(対のないサロゲートのエスケープ、f64 を超える数)は、TypeScript と違う答えになりうる。どれも corpus の件には出ない

## 確かめたこと

2026-11-08、Linux(omarchy)、rustc 1.99.1、Bun 1.4.4、`rust` の `82f36ce` から切ったブランチで確かめた。

- `rust/` で `cargo fmt --check`、`cargo clippy --locked --workspace --all-targets -- -D warnings`、`cargo test --locked --workspace` が通った。CI の「Parsing crates have no I/O dependencies」の手順を、`.github/workflows/rust.yml` から取り出してそのまま bash で実行し、終了コード 0 だった
- `cargo tree --locked -p herdr-fleet-screen -e normal` と `-p herdr-fleet-transcript -e normal` に、herdr-fleet-herdr、herdr-fleet-child-process、tokio、axum、hyper、reqwest は出ない
- 依存の一覧は `cargo metadata --format-version 1 --locked` の `packages`(`source` のあるもの)から作り、公開日と最新の版は crates.io の API で読んだ
- 文字の幅と grapheme の比べ方: Bun のスクリプトが `fixtures/screens/*/*/screen.txt` を読み、出てくるすべての code point の `Bun.stringWidth`、すべての行(そのままと `ANSI_RE` を除いたもの)の `Intl.Segmenter`(granularity `grapheme`)の区切り、各 grapheme と行全体の `Bun.stringWidth` を JSON に書いた。scratchpad の Rust のプログラム(unicode-width 0.2.3、unicode-segmentation 1.13.3)がそれを読み、`char::width`、`str::width`、`graphemes(true)` と比べた。結果は上の「文字の幅と grapheme」のとおり
- 正規表現と JSON の違いは、scratchpad の Rust のプログラム(regex 1.13.1、serde_json 1.0.154 と `preserve_order`、base64 0.23.1)と Bun 1.4.4 で、上に書いた入力ごとに答えを出して比べた。数の書き方(120,014 の数)、base64 の決まり(表の 18 の入力)、`/:\s*\S{0,3}$/` の書き換え(21,845 の文字列)は、決まりを Rust で書いて Bun の答えと比べ、どれもすべて一致した
- `float_roundtrip`: `rust/crates/protocol/tests/types.rs` の `a_number_reads_as_javascripts_json_parse_reads_it` が、feature なしで `left: Some(1.0)` で失敗し、足したあとに通った。`Cargo.lock` は変わらなかった
- レビュー(PR の codex のレビュアーと `/code-review high`)で、`float_roundtrip`、配列の添字の形のキーの順序、数の桁の選び方、f64 を超える数、base64 の ASCII でない文字、回数の指定、ESC のあとの文字、最後の行の `\r` の決まりの誤りと抜けを指摘され、上のとおりに直した
