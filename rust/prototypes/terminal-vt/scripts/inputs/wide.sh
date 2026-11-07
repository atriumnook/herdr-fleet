#!/bin/sh
# Wide characters on a narrow screen: wrapping at a wide character, a wide
# character overwritten half-way, combining marks, emoji, and tabs.
printf '日本語の文字は二つのセルを使います。この行は折り返されます。\n'
printf 'abcdefghijklmnopqrstuvwxyz0123456789ab日\n'
printf 'abcdefghijklmnopqrstuvwxyz0123456789abc日本\n'
printf '結合文字: か\314\201 \343\201\213\343\202\231 e\314\201 n\314\203\n'
printf '絵文字: 🙂👍🏽 👨‍👩‍👧 🇯🇵 ✔️ ☺\357\270\217\n'
printf 'tab:\tA\tBB\tCCC\n'
printf '上書き前の行です\r\033[3C|\n'
printf 'ｱｲｳｴｵ半角カナと全角カナアイウエオ\n'
printf '\033[5;20H中\033[5;21Hx\n'
printf '\033[12;1H最下行の漢字'
