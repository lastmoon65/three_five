# 《红心对决》二期接口契约（6 人两副牌增量）

- 版本：v2.0（2026-08-03）
- 基线：一期实际实现协议（auth / create_room / join_room / ready / start_game / reveal / tribute_take / bury / play / next_round / leave_room / swap_seats；全量 game_state + seq 快照）。
- 说明：只列二期新增与改动；未列出的消息/字段与一期完全一致。

## 1. 传输约定（不变）

- 单 WebSocket 通道 `/ws`，消息 `{type, data}`。
- 认证：`{type:"auth", data:{username,password}}` 或重连 `{type:"auth", data:{token}}`。
- 错误统一 `{type:"error", data:{code,message}}`。
- 状态变更一律服务端广播；客户端消息仅为请求。

## 2. 数据模型（二期差异）

```
CardDTO   {id, suit, rank, power, points}
          // id 带副序号：heart_A_0 / heart_A_1（两副牌）；power/points 与副序号无关
SeatDTO   {seatId, userId, nickname, ready, connected, isHost, team}
          // 6 人模式 seats[6]；team = seatId % 2（0/2/4 一队，1/3/5 一队）
RoomDTO   {roomId, mode: "p4"|"p6", phase, hostSeatId, seats[]}
GameDTO   {roomId, seq, mode, roundNo, phase, dealerIndex, currentSeat,
           seats[], myHand[], handCounts[], revealed[], effectiveReveal,
           rebellionLevel, tributePlan, tributeState, bottom[],
           scores[2], trick, legalPlays, message}
          // handCounts/seats 长度随模式；scores 恒为两队；rebellionLevel 0/1/2
TributeDTO {step:"take", pairIdx, pairs:[{giver, taker}]}
           // 单进贡 pairs 1 组；三进贡 pairs 3 组（对位配对 (seat+3)%6）
RoundResult {scores[2], dealerStay, newDealerIndex, tribute:"none"|"single"|"triple", rebellionLevel}
```

## 3. 客户端 → 服务端（二期改动）

| type | data | 二期变化 |
| --- | --- | --- |
| auth | {username,password} 或 {token} | 不变 |
| create_room | **{mode:"p4"\|"p6"}** | 新增必填 mode；房号位数随模式 |
| join_room | {roomId} | 服务端按位数预判模式并校验 room.mode |
| ready | 无 | 不变 |
| start_game | 无 | 6 人模式校验 6 席满+全在线+全准备，否则 `NOT_READY` |
| reveal | {cardIds:null \| 3 张} | 不变；服务端统计闲家方生效亮番 → rebellionLevel |
| tribute_take | {cardId} | 支持 1~3 组退贡（pairIdx 由服务端状态决定） |
| bury | {cardIds:[6 张]} | 23 张手牌中选 6 张；无分约束 + 兜底阈值 12 |
| play | {cardIds} | **4 张上限**（真杠/假杠/四清）；8 张同点由服务端校验只能选 4 张 |
| next_round | 无 | 不变 |
| leave_room / swap_seats | 无 / {a,b} | 不变（6 人换位规则见决策清单） |

## 4. 服务端 → 客户端（二期新增字段）

| type | 二期变化 |
| --- | --- |
| auth_ok | 不变 |
| room_updated | RoomDTO 增加 mode；seats 长度随模式 |
| game_state | GameDTO 增加 mode、rebellionLevel；handCounts/scores 长度随模式 |
| error | 新增错误码：`JOIN_MODE_MISMATCH`、`ROOM_FULL`（6 人版）、`BAD_MODE`、`NOT_ENOUGH_PLAYERS` |

## 5. 服务端裁决新增点（规则 → 契约映射）

1. **两副牌卡牌身份**：发牌时每张卡 id 带副序号 0/1；同一 rank+suit 两张可共存于一手牌。
2. **真杠**：`play.cardIds.length === 4` 且 4 张同 rank；8 张同 rank 只能分两次出，单次仍 4 张。
3. **假杠**：黑桃 Q（任一副）+ 3 张同 rank，共 4 张。
4. **四清**：4 张 4 领出触发垫分；8 张 4 拆两副。
5. **甩牌**：花色甩/主牌甩"前 N 张"按 power 排序，重复牌（两张同 rank+suit）按两张计。
6. **同牌力**：任意维度出现同牌力（两张方块 5、两副 KKKK、多张副 J/副 2）→ 先出者大，后出不能压。
7. **进贡阈值**（总分 200）：<80 守庄 / 80~119 换庄 / 120~159 单进贡 / 160~200 三进贡。
8. **分层造反**：闲家方生效亮番人数 1 → 免单进贡；≥2 → 免三进贡；换庄判定不受影响。
9. **三进贡配对**：庄家方 3 人 ↔ 闲家方 3 人，按 `(seat+3)%6` 对位，退贡原路返回。
10. **埋底兜底**：庄家 23 张中分牌 ≥12 → 扣分值最小 6 张，分牌分归庄家方，底牌公开。

## 6. 示例

```
C→S: {"type":"create_room","data":{"mode":"p6"}}
S→C(全房): {"type":"room_updated","data":{"roomId":"482917","mode":"p6","phase":"waiting","seats":[6席]}}

C→S: {"type":"play","data":{"cardIds":["club_7_0","club_7_1","heart_7_0","heart_7_1"]}}  // 真杠：4 张同点 7
S→C(全房): {"type":"game_state","data":{"phase":"trick","trick":{...},"rebellionLevel":1,"seq":37}}

S→C(违规): {"type":"error","data":{"code":"BAD_PLAY","message":"真杠最多 4 张，8 张同点需分两次出"}}
```
