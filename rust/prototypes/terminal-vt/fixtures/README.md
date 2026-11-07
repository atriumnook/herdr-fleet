# 記録したペインのバイト列と Ghostty の画面

1 件が 1 つのフォルダーで、次の 3 つのファイルを持つ。

- `output.bin`: プログラムが pty に書いたバイト列。pty の master の側で読んだまま(行末の `\r\n` も、端末への問い合わせも含む)
- `size.txt`: 記録したときの pty の大きさ。`<列数>x<行数>`
- `ghostty-screen.txt`: `output.bin` を、同じ列数と行数の Ghostty 1.4.0 に流したあと、Ghostty の `write_screen_file:paste,plain` が書き出したファイル。手を加えていない

## 件

| 件 | 大きさ | 内容 | 確かめること |
| --- | --- | --- | --- |
| `nvim-japanese` | 100x30 | `nvim --clean` で `scripts/inputs/japanese.txt` を開いた画面 | 代替画面の全画面 TUI、全角文字、半角カナ、絵文字、折り返し |
| `less-sgr` | 90x28 | `less -R` で `scripts/inputs/sgr.sh` の出力を開いた画面 | 代替画面、256 色と 24 bit 色の SGR |
| `sgr-colors` | 80x24 | `scripts/inputs/sgr.sh` の出力(主画面) | 256 色と 24 bit 色の SGR、コロン区切りの SGR、スクロールバック |
| `wide-chars` | 40x12 | `scripts/inputs/wide.sh` の出力 | 行末で入らない全角文字の折り返し、全角文字の半分への上書き、結合文字、絵文字の ZWJ と異体字セレクター、タブ |
| `scroll-wrap` | 60x10 | `scripts/inputs/scroll.sh` の出力 | 行の折り返し、行末ちょうどで止まった折り返し待ち、スクロールバック |
| `claude-startup` | 100x30 | Claude Code 2.1.319 の起動画面(空の設定フォルダーでの初回の画面) | エージェント CLI の起動画面、24 bit 色 |
| `codex-startup` | 100x30 | Codex の起動画面(空の `CODEX_HOME` でのサインインの画面) | エージェント CLI の起動画面、代替画面 |

## 記録の取り方

`scripts/record-all.sh` が全件の `output.bin` と `size.txt` を取り直す。1 件ごとに `scripts/record.py` が次のことをする。

1. util-linux の `script`(2.42.4)で pty を作り、`stty rows <行数> cols <列数>` のあとにプログラムを起動する
2. プログラムには入力を何も送らない(標準入力は開いたままの空のパイプ)。決めた秒数のあとに SIGKILL で止める。全画面のプログラムは、代替画面のままで記録が終わる
3. `script -O` のファイルは、バイト列の前後に見出しの行を持つ。`-m advanced -T` のタイミングファイルにある出力のバイト数の合計で、本体だけを取り出す

プログラムに渡す環境変数は `PATH`、`HOME`、`TERM=xterm-256color`、`COLORTERM=truecolor`、`LANG=en_US.UTF-8` と、各件の指定だけで、`HERDR_*` は渡さない。エージェント CLI は、空の作業フォルダーと空の設定フォルダー(`CLAUDE_CONFIG_DIR`、`CODEX_HOME`)で起動する。サインインしていない初回の画面が出て、使う人の設定とサインインの情報を読まない。モデルにはプロンプトを送らない。

## Ghostty の画面の取り方

`scripts/capture_ghostty.py <件のフォルダー>...` が `ghostty-screen.txt` を書く。Ghostty と Hyprland(0.56。`hyprctl dispatch` が Lua を受け取る版)が要る。

1. Hyprland の `hl.exec_cmd(..., { float = true })` で、浮動の Ghostty の窓を開く。`--config-default-files=false`(使う人の設定を読まない)、`--gtk-single-instance=false`(動いている Ghostty につながない)、装飾と余白なし、`--window-width` と `--window-height` に件の列数と行数を渡す
2. 窓の中で `scripts/ghostty_replay.py` が動く。端末の大きさが件の大きさと違えば、何も描かずに止まる。同じなら、tty を raw にして(出力の変換もエコーもしない)、`output.bin` をそのまま書く
3. 書き終えて 1 秒後に、Hyprland の `hl.dsp.send_shortcut` で、その窓に Ctrl+Shift+F12 を送る。この窓の設定では、このキーが `write_screen_file:paste,plain` を呼ぶ。Ghostty は、スクロールバックと画面の全体を、折り返した行をつなぎ、行末の空白を削らずにファイルに書き、そのパスを pty に貼る
4. `ghostty_replay.py` がそのファイルを `ghostty-screen.txt` に写し、Ghostty の一時ファイルを消して終わる。窓が閉じる

記録したプログラムの問い合わせ(DA、DSR、OSC 10/11)に Ghostty が答えるので、貼られたパスの前に答えが届く。`ghostty_replay.py` は、届いた入力からパスの形の部分を探す。
