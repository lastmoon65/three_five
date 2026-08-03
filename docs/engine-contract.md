# 规则引擎接口契约（game.mjs）

- 版本：v1（2026-08-03）
- 定位：纯 ES Module，无 DOM、无 Node 内置模块依赖，浏览器 `<script type="module">` 与 Node 均可直接 import；持有全部对局状态，方法内部校验合法性；不关心 UI/网络。
- 文件：`game/game.mjs`；根目录可加最小 `package.json`（`{"type":"module"}`）。

## 数据模型

```
Card   {id, suit:"spade|heart|club|diamond|joker", rank, power, points}
Seat   {index:0..3, name, isDealer, team}
state  {phase, roundNo, dealerIndex, currentSeat, hands[4], bottom[],
        revealed[], tributePlan, buried[], trick{leaderSeat, dimension, plays[], winnerSeat?},
        scores[2], result?}
```

## 阶段

`reveal` → `tribute`? → `bury` → `trick`（循环）→ `round_end` → `nextRound()` 回 `reveal`

## 公开 API

| 方法 | 说明 |
| --- | --- |
| createDeck() | 生成 54 张牌（含 power/points，按规则 V8.3 §2） |
| newGame(names: string[4], rng?) | 创建游戏；rng 可注入便于测试，默认 Math.random |
| state() | 返回深拷贝快照 |
| startRound() | 洗牌发牌（每人12、底6）；首副庄家随机，后续按轮庄；设置本副 tributePlan（依据上一副 result，首副无） |
| legalReveals() | 亮牌阶段：当前座位可亮的牌组（三张3/三张5），无则返回 [] |
| reveal(cardIds \| null) | 亮/跳过；按"五反>三反、先亮优先、后亮可覆盖"判定生效；全部座位操作完 → 判定造反 → 进 tribute 或 bury |
| tributeGive() | 进贡侧（败方=庄家方）自动给出最大牌；推进到退贡者 |
| tributeTake(cardId) | 退贡者退任意主牌（无主牌兜底退任意牌）；双进贡依序两轮；造反成立则整阶段跳过 |
| bury(cardIds: string[6]) | 庄家 18 张中选 6 张扣回；校验无分；≥7 张分时按兜底扣最小分值 6 张（底牌分归庄家方）；公开底牌；进入 trick |
| legalPlays() | 打牌阶段：当前座位合法出牌列表 `[{cardIds[], dimension}]`，UI 高亮用 |
| play(cardIds) | 出牌（首出定维度，其余强制跟牌）；非法抛 Error 且状态不变；每墩 4 家出完自动裁决：赢家得墩内分并成为下一领出者；手牌空 → round_end |
| roundResult() | `{scores, dealerStay, tribute, newDealerIndex, streak}` |
| nextRound() | 应用换庄/连庄3副，进入下一副 reveal |

## 关键约定（必须与规则 V8.3 一致）

- 牌力表、分牌 5/10/K、常主不按花色、六维度（单牌/花色甩/主牌甩/假杠/真杠/四清）、真杠按点数可压、四清垫分先高后低、甩牌前 N 张合法性、跟牌校验。
- 进贡 40/60/80 阈值、换庄 ≥40、连庄 3 副队友接任、首副随机庄家、造反取消进贡。
- 出牌顺序逆时针：next = (seat+3)%4；对家 = (seat+2)%4。
- 所有非法输入抛 Error 且不改变任何状态；`state()` 不得返回内部引用。