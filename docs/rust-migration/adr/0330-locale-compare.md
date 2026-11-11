# localeCompare の並びを protocol::js の locale_compare 1 つにする

- 状態: 採用
- 決めた日: 2026-11-12
- Issue: #330

## 状況

TypeScript は、使用量の一覧(`server/fleet/usage.ts` の `list()`)と設定の画面の役割(`server/fleet/settings.ts`)を `a.localeCompare(b)` で並べる。Rust では、Bun 1.4.4 の en-US の並びを写した規則が 2 か所にあった: `rust/crates/orchestrator/src/usage/tracker.rs` の `locale_key` と `primary_weight`(#254、ADR `0254-usage-interface`)と、`rust/crates/orchestrator/src/settings.rs` の `locale_compare`(#260、ADR `0260-settings-store`)。#260 は `tracker.rs` を書けなかったので写した。

ADR `0193-protocol-types` は、2 つ以上の crate が使う JavaScript の文字列の振る舞いを `protocol::js` に置き、1 つの crate だけが使うものはその crate に置くと決めている。いまの呼び手は 2 つとも orchestrator にある。protocol の公開の口に関数を足すので、architect(fleet の run `7db65b87`、読むだけ)に問い、その答えに従った。

## 決定

`rust/crates/protocol/src/js/locale.rs` に `pub fn locale_compare(a: &str, b: &str) -> std::cmp::Ordering` を置き、`protocol::js::locale_compare` として公開する。`tracker.rs` の `list()` と `settings.rs` の `by_flow` はこれで並べ、2 つの写しは消す。

置く場所を `protocol::js` にした理由:

- 移す TypeScript のコードには、orchestrator のほかに `localeCompare` を使う箇所がある。段階 4 の core が引き継ぐ `server/commands.ts:173`、`server/files.ts:40`・`86`、`server/index.ts:1220` と、desktop が引き継ぐ `src/ui/fleetView.ts:379`・`418`・`658`。desktop は orchestrator に依存しない(依存は protocol と vt)。ADR `0193-protocol-types` の「検討した代わり」も、あとの段階で使う crate を数えて `protocol::js` を選んでいる
- orchestrator に置けば、2 つ目の crate が要るときに写しを作り、消すための Issue を別に開くことになる。`stringify_pretty` がその道をたどった(ADR `0244-phase-3-dependencies`、#275)
- orchestrator の非公開の module にするには `lib.rs` か `usage/mod.rs` を書く必要があり、#330 の書くパスにない

形を比較関数にした理由: TypeScript の呼び出しは `a.localeCompare(b) || …` の連鎖で、`locale_compare(a, b).then_with(|| …)` にそのまま写る。並べ替えの鍵の型にすると、重みの表という内部の決定が公開の口に出る。中身を照合の crate に替えても、呼ぶ側は変わらない。

### ASCII の範囲で Bun に合わせたこと

architect が、前の 2 つの写しが ASCII の範囲でも Bun 1.4.4 と違う順を返すことを見つけたので、この関数で合わせた。値は `LANG=en_US.UTF-8` の Bun 1.4.4 の `a.localeCompare(b)`。

| 比べた組 | Bun | 前の規則 | 原因 |
|---|---|---|---|
| `"a\tz"` と `"a b"` | -1 | Greater | 前の規則は空白をすべて同じ重みにした。Bun は `\t`、`\n`、`\v`、`\f`、`\r`、空白の順に重みを付ける |
| `"a\u000bb"` と `"aab"` | -1 | Greater | `char::is_ascii_whitespace` は U+000B を含まないので、英字のあとに並んだ |
| `"a\u0001b"` と `"ab"` | 0 | Greater | Bun は ASCII の制御文字のうち上の 5 つ以外(U+0000〜U+0008、U+000E〜U+001F、U+007F の 28 文字)を無視する |

無視する文字は重みの列からも大文字の列からも外す。そのため、無視する文字だけが違う 2 つの文字列は `Equal` になり、JavaScript の 0 と同じになる。前の規則の最後の `a.cmp(b)` は消した。`sort_by` は `Array.prototype.sort` と同じく安定なので、`Equal` の要素は入力の順のまま残る。

### 引き継ぐこと

ASCII でない文字は、前と同じく英字のあとに code point の順で並ぶ。ロケールは `é` を `e` の隣に置くので、そこが TypeScript と違う。合わせるには照合の crate(icu4x の `icu_collator` など)と manifest の変更が要り、#330 の書くパスにないので、#356 に分けた。ADR `0260-settings-store` が「ASCII でない文字の並びも #330 で扱う」と書いた件と、`rust/crates/orchestrator/tests/settings.rs` の `lists_role_names_past_ascii_as_locale_compare_does` の `#[ignore = "#330: …"]` は、#356 が引き継ぐ。

## 検討した代わり

- orchestrator の非公開の module に置く: 上の「置く場所」の理由
- 並べ替えの鍵の型(`locale_key(&str) -> LocaleKey`)を公開する: 得られるのは `sort_by_cached_key` で鍵を 1 回ずつ作れることだけで、一覧は数十件なので差が出ない。比較の連鎖を鍵の形に組み直すことになる
- ASCII の 3 つの違いを直さず、違いとして記録する: 直すのは関数の中だけで、呼び手の 2 つの受け入れテストは期待値を変えずに通るので、直した

## 依存

なし。

## 結果

- `localeCompare` で並べるコードを移すときは、`protocol::js::locale_compare` を呼ぶ。写しを作らない
- ASCII の文字列は、Bun 1.4.4 の en-US と同じ順に並ぶ。ASCII でない文字は #356 まで違う
- `rust/crates/orchestrator/src/metrics.rs` の役割の並び(ADR `0259-metrics-interface` でバイトの順と決めた)は変えていない。#356 の注意に書いた

## 確かめたこと

2026-11-12、Linux(Omarchy、kernel 7.2.15)、Bun 1.4.4(`HERDR_*` を外し、`LANG=en_US.UTF-8`)、`rust/` で確かめた。

- 期待値は Bun の `bun -e` で取った: ASCII の 128 文字を U+007F から U+0000 の順に並べた配列の `.sort((a, b) => a.localeCompare(b))`、23 個の語の並び、14 組の `a.localeCompare(b)`
- `cargo test --locked -p herdr-fleet-protocol --test js`: 関数が `todo!()` の stub のとき、足した 3 件が失敗した(`panicked at crates/protocol/src/js/locale.rs:4:5`)。前の規則を写した実装では、制御文字と空白の 2 件が失敗した(`panicked at crates/protocol/tests/js.rs:160:5` と `218:9`)。この ADR の実装で 10 件が通った
- `cargo test --locked -p herdr-fleet-orchestrator --test settings --test usage`: `lists_the_persons_roles_by_name_as_locale_compare_does` と `lists_the_accounts_in_the_order_of_locale_compare` が期待値を変えずに通った
- `cargo fmt --check`、`cargo clippy --locked --workspace --all-targets -- -D warnings`、`cargo test --locked --workspace`
