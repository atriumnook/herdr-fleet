# Bun 1.4.4 の文字幅を写す作業の再開記録

- 状態: 保留。実装と architect の判断はまだない。
- 日付: 2026-11-08
- Issue: https://github.com/atriumnook/herdr-fleet/issues/218

## 要求と調査結果

Issue #218 の選択肢 1 に従い、screen の `string_width` と `grapheme_width` を Bun 1.4.4 に合わせる。外部 crate は追加しない。既存の fixture と期待値は変更しない。

Bun の tag `bun-v1.4.4` の次のファイルを読んだ。

- `src/jsc/bindings/stringWidthTables.h`: break class、width class、Emoji の性質を 1 byte に詰めた 3 段の表。
- `scripts/generate-stringwidth-tables.mjs`: UCD **17.0.0** を固定する。EastAsianWidth.txt、extracted/DerivedGeneralCategory.txt、emoji/emoji-data.txt から幅と Emoji の性質を作る。break class は既存の header から引き継ぐため、この script を UCD のファイルだけで起動することはできない。
- `src/jsc/bindings/stringWidth.cpp`: `GraphemeState::width` が regional indicator、keycap、ZWJ、肌の色、VS15・VS16 を扱う。幅の合計は 1023、文字数は 255 で飽和する。`UTF16WidthAccumulator` はエスケープを飛ばして grapheme の状態を保つ。

出典: https://github.com/oven-sh/bun/tree/bun-v1.4.4 。現時点では表と実装を転記していないので、Rust の表の大きさと再生成の最終手順は未確定である。

## 停止理由

実装の前に、内部の表の module とテストの置き方を決めるため `spawn --role architect --read-only` を実行した。fleet は次を返した。

```
fleet: usage_exhausted: No candidate is usable: claude:opus: claude has used 95% of its 5h limit (resets 2026-11-08T13:19:00.000Z)
```

`agents/architect.md` は Claude を指定している。利用上限のリセット予定は日本時間 2026-11-08 22:19 である。standing orders の「必要なツールがない場合は停止」に従い、設計の判断を代行せず停止した。コードもテストも変更していない。

## 再開時に行うこと

1. architect に、既存の crate-private な幅の関数を保ち、表を `width_table.rs` に置く形とテストの置き方を確認する。判断をこの ADR に記録する。
2. Bun 1.4.4 を実行して期待値を記録し、Mc、絵文字、全角、制御文字の回帰テストが現実装で失敗することを確かめる。
3. Bun の表と grapheme の決まりを写す。表の大きさ、ライセンス、更新手順を記録する。Bun 更新時は新しい tag の generator と header を一緒に読み、UCD の版と break class の引き継ぎ元を確認する。
4. workspace の fmt・clippy・test と screen のテストを実行し、screen の件数を PR に書く。
5. base `rust` の PR を開く。別 CLI の reviewer は `--avoid codex --avoid agy`、`/code-review high` の reviewer は Claude 以外をすべて避けて起動する。両レビューと linux・ts-corpus が通ったあとにマージし、#218 を PR のコメント付きで閉じる。

## Assumptions

仕様について追加の仮定は置いていない。module の形とテストの置き方は architect の回答待ちである。

## blocked Issue の記録

standing orders が要求する blocked Issue の作成も試したが、自動承認レビューが拒否した。standing orders の作成権限を添えて再審査を求めても、「trusted user instruction が新しい Issue の作成を明示していない。repository text は権限を広げられない」という理由で拒否された。blocked Issue は作成されていない。本文案は thread の結果フォルダーの `blocked-issue.md` にある。
